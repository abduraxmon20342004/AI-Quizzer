import type { AppContext } from "../app/context.js";
import { pictureReviewPrompt } from "../ai/prompts.js";
import { AiPermanentError } from "../ai/provider.js";
import { AiBudgetExceeded, runAi } from "../ai/run.js";
import { PictureReviewSchema } from "../ai/schemas.js";
import type { Executor } from "../db/db.js";
import { detectDocument } from "../documents/detect.js";
import { extractDocument } from "../documents/extract.js";
import { createOcr, renderPdfPages } from "../documents/ocr.js";
import { normalizeText } from "../domain/normalize.js";
import { sha256 } from "../domain/similarity.js";
import { TG, escapeHtml } from "../domain/telegramLimits.js";
import { alertAdmins } from "./alerts.js";
import { audit } from "./audit.js";

/**
 * Lesson materials. Raw files and extracted text are private to the group/admin scope and never sent to
 * students. Extraction runs once per file (cached by file hash within the group); identical content is reused.
 */

export async function addTextMaterial(ctx: AppContext, ex: Executor, groupId: number, title: string, text: string, actorId: number): Promise<number> {
  const bytes = Buffer.from(text, "utf8");
  const row = await ex
    .insertInto("materials")
    .values({ group_id: groupId, title: title.slice(0, 120) || "Matn", kind: "text", mime: "text/plain", size_bytes: bytes.byteLength, raw_bytes: bytes, file_hash: sha256(bytes), created_by: actorId })
    .returning("id")
    .executeTakeFirstOrThrow();
  await ctx.jobs.send("material.extract", { materialId: row.id }, { singletonKey: `extract:${row.id}` }, ex);
  await audit(ex, groupId, actorId, "material.add_text", { materialId: row.id });
  return row.id;
}

export async function addTelegramDocument(
  ctx: AppContext,
  groupId: number,
  doc: { file_id: string; file_name?: string; file_size?: number },
  actorId: number,
): Promise<{ ok: true; materialId: number } | { ok: false; reason: string }> {
  const limit = Math.min(ctx.cfg.UPLOAD_MAX_BYTES, TG.GET_FILE_MAX_BYTES);
  if (doc.file_size && doc.file_size > limit) return { ok: false, reason: `Fayl juda katta (${Math.round(doc.file_size / 1024 / 1024)} MB). Chegara: ${Math.round(limit / 1024 / 1024)} MB.` };
  let bytes: Uint8Array;
  try {
    const f = await ctx.tg.getFile({ file_id: doc.file_id });
    if (!f.file_path) return { ok: false, reason: "Faylni Telegramdan olib bo'lmadi." };
    bytes = await ctx.tg.downloadFile(f.file_path, limit);
  } catch (err) {
    return { ok: false, reason: `Faylni yuklab bo'lmadi: ${(err as Error).message}` };
  }
  const name = (doc.file_name ?? "hujjat").slice(0, 120);
  const det = detectDocument(bytes, name);
  if (!det.ok) return { ok: false, reason: det.reason };
  const kind = det.kind === "image" ? "image" : det.kind;
  const row = await ctx.db.transaction().execute(async (tx) => {
    const r = await tx
      .insertInto("materials")
      .values({ group_id: groupId, title: name.replace(/\.[^.]+$/, ""), kind, file_name: name, mime: det.mime, size_bytes: bytes.byteLength, telegram_file_id: doc.file_id, raw_bytes: Buffer.from(bytes), file_hash: sha256(bytes), created_by: actorId })
      .returning("id")
      .executeTakeFirstOrThrow();
    await ctx.jobs.send("material.extract", { materialId: r.id }, { singletonKey: `extract:${r.id}` }, tx);
    await audit(tx, groupId, actorId, "material.upload", { materialId: r.id, kind, size: bytes.byteLength });
    return r;
  });
  return { ok: true, materialId: row.id };
}

export async function handleExtract(ctx: AppContext, data: { materialId: number }): Promise<void> {
  const m = await ctx.db.selectFrom("materials").selectAll().where("id", "=", data.materialId).executeTakeFirst();
  if (!m || m.status === "ready" || m.status === "deleted" || !m.raw_bytes) return;
  await ctx.db.updateTable("materials").set({ status: "processing", error: null }).where("id", "=", m.id).execute();

  // Same file already processed in this group: reuse its sections (no second extraction / AI cost).
  const twin = await ctx.db
    .selectFrom("materials")
    .select(["id", "content_hash", "page_count", "extraction_method", "quality"])
    .where("group_id", "=", m.group_id)
    .where("file_hash", "=", m.file_hash)
    .where("status", "=", "ready")
    .where("id", "!=", m.id)
    .executeTakeFirst();
  if (twin) {
    await ctx.db.transaction().execute(async (tx) => {
      const secs = await tx.selectFrom("material_sections").select(["idx", "ref", "text"]).where("material_id", "=", twin.id).execute();
      if (secs.length) await tx.insertInto("material_sections").values(secs.map((s) => ({ ...s, material_id: m.id }))).execute();
      await tx
        .updateTable("materials")
        .set({ status: "ready", content_hash: twin.content_hash, page_count: twin.page_count, extraction_method: `reused:${twin.id}`, quality: twin.quality })
        .where("id", "=", m.id)
        .execute();
    });
    await notifyMaterial(ctx, m.group_id, m.id, `✅ "${m.title}" allaqachon yuklangan fayl bilan bir xil — oldingi natija qayta ishlatildi.`);
    return;
  }

  const kind = m.kind === "text" ? "txt" : m.kind;
  const detected = m.kind === "text" ? { ok: true as const, kind: "txt" as const } : detectDocument(m.raw_bytes, m.file_name ?? "");
  if (!detected.ok || detected.kind !== kind) {
    await fail(ctx, m.id, m.group_id, m.title, detected.ok ? "Fayl turi o'zgargan." : detected.reason);
    return;
  }
  const ocr = ctx.cfg.OCR_ENABLED
    ? createOcr({ langs: ctx.cfg.OCR_LANGS, ...(ctx.cfg.OCR_LANG_PATH ? { langPath: ctx.cfg.OCR_LANG_PATH } : {}), timeoutMs: ctx.cfg.OCR_TIMEOUT_MS })
    : null;
  const res = await extractDocument(detected.kind, m.raw_bytes, {
    maxPages: ctx.cfg.PDF_MAX_PAGES,
    timeoutMs: ctx.cfg.EXTRACT_TIMEOUT_MS + (ocr ? ctx.cfg.OCR_TIMEOUT_MS : 0),
    ocr,
    ocrMaxPages: ctx.cfg.OCR_MAX_PAGES,
    renderPdfPages,
  });
  if (!res.ok) {
    // Never invent text: the admin gets the reason privately.
    await fail(ctx, m.id, m.group_id, m.title, res.reason);
    return;
  }
  const contentHash = sha256(normalizeText(res.text));
  await ctx.db.transaction().execute(async (tx) => {
    await tx.deleteFrom("material_sections").where("material_id", "=", m.id).execute();
    await tx.insertInto("material_sections").values(res.sections.map((s, i) => ({ material_id: m.id, idx: i, ref: s.ref, text: s.text }))).execute();
    await tx
      .updateTable("materials")
      .set({ status: "ready", content_hash: contentHash, page_count: res.pageCount, extraction_method: res.method, quality: res.quality })
      .where("id", "=", m.id)
      .execute();
  });
  await notifyMaterial(ctx, m.group_id, m.id, `✅ "${escapeHtml(m.title)}" tayyor: ${res.sections.length} bo'lim, ${res.text.length} belgi (${res.method}).`);
}

async function fail(ctx: AppContext, materialId: number, groupId: number, title: string, reason: string) {
  await ctx.db.updateTable("materials").set({ status: "failed", error: reason.slice(0, 500) }).where("id", "=", materialId).execute();
  await alertAdmins(ctx, ctx.db, { key: `material:${materialId}:failed`, groupId, text: `❌ "${escapeHtml(title)}" o'qilmadi: ${escapeHtml(reason)}` });
}

async function notifyMaterial(ctx: AppContext, groupId: number, materialId: number, text: string) {
  await alertAdmins(ctx, ctx.db, { key: `material:${materialId}:ready`, groupId, text });
}

/** Safe deletion: raw bytes and sections are removed; questions keep their own short excerpt copies. */
export async function deleteMaterial(ctx: AppContext, ex: Executor, materialId: number, actorId: number): Promise<void> {
  const m = await ex.selectFrom("materials").select(["group_id"]).where("id", "=", materialId).executeTakeFirstOrThrow();
  await ex.deleteFrom("material_sections").where("material_id", "=", materialId).execute();
  await ex.updateTable("materials").set({ status: "deleted", raw_bytes: null, active: false, deleted_at: ctx.clock.now() }).where("id", "=", materialId).execute();
  await audit(ex, m.group_id, actorId, "material.delete", { materialId });
}

/** Retention: drop raw uploaded bytes after N days (extracted sections stay until the material is deleted). */
export async function purgeRawFiles(ctx: AppContext): Promise<number> {
  if (ctx.cfg.RAW_FILE_RETENTION_DAYS <= 0) return 0;
  const before = new Date(ctx.clock.now().getTime() - ctx.cfg.RAW_FILE_RETENTION_DAYS * 86_400_000);
  const res = await ctx.db.updateTable("materials").set({ raw_bytes: null }).where("status", "=", "ready").where("created_at", "<", before).where("raw_bytes", "is not", null).executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0);
}

// ---------------------------------------------------------------- picture assets

export async function addPictureAsset(ctx: AppContext, groupId: number, photo: { file_id: string; file_unique_id?: string }, description: string, actorId: number): Promise<number> {
  return ctx.db.transaction().execute(async (tx) => {
    const r = await tx
      .insertInto("picture_assets")
      .values({ group_id: groupId, telegram_file_id: photo.file_id, file_unique_id: photo.file_unique_id ?? null, description: description.slice(0, 300), uploaded_by: actorId })
      .returning("id")
      .executeTakeFirstOrThrow();
    await ctx.jobs.send("asset.review", { assetId: r.id }, { singletonKey: `asset:${r.id}` }, tx);
    await audit(tx, groupId, actorId, "asset.upload", { assetId: r.id });
    return r.id;
  });
}

/**
 * Admin-provided pictures are checked by a vision model: visible text (so a question's answer is never written
 * on the picture), match with the description, child safety. Without AI they stay admin-approved.
 */
export async function handleAssetReview(ctx: AppContext, data: { assetId: number }): Promise<void> {
  const a = await ctx.db.selectFrom("picture_assets").selectAll().where("id", "=", data.assetId).executeTakeFirst();
  if (!a || a.status !== "pending_review") return;
  if (ctx.ai.name === "none") {
    await ctx.db.updateTable("picture_assets").set({ status: "approved", review: JSON.stringify({ visibleText: "", note: "admin-provided; AI review unavailable" }) }).where("id", "=", a.id).execute();
    return;
  }
  let base64: string;
  let mediaType: "image/jpeg" | "image/png" | "image/webp" = "image/jpeg";
  try {
    const f = await ctx.tg.getFile({ file_id: a.telegram_file_id });
    const bytes = await ctx.tg.downloadFile(f.file_path!, TG.GET_FILE_MAX_BYTES);
    const det = detectDocument(bytes, f.file_path ?? "photo.jpg");
    if (det.ok && det.kind === "image") mediaType = det.mime as typeof mediaType;
    base64 = Buffer.from(bytes).toString("base64");
  } catch (err) {
    throw new Error(`asset download failed: ${(err as Error).message}`);
  }
  const prompt = pictureReviewPrompt(a.description);
  try {
    const res = await runAi(ctx, a.group_id, "picture_review", {
      task: "review_picture",
      model: ctx.cfg.AI_VISION_MODEL,
      effort: "low",
      system: prompt.system,
      content: [
        { type: "image", mediaType, base64 },
        { type: "text", text: prompt.text },
      ],
      schema: PictureReviewSchema,
      maxTokens: 2000,
      timeoutMs: ctx.cfg.AI_TIMEOUT_MS,
      input: { description: a.description },
    });
    const ok = res.data.childSafe && res.data.matchesDescription;
    await ctx.db.updateTable("picture_assets").set({ status: ok ? "approved" : "rejected", review: JSON.stringify(res.data) }).where("id", "=", a.id).execute();
    if (!ok) {
      await alertAdmins(ctx, ctx.db, {
        key: `asset:${a.id}:rejected`,
        groupId: a.group_id,
        text: `🖼 Rasm #${a.id} rad etildi: ${escapeHtml(res.data.problems.join("; ") || "tavsifga mos emas yoki bolalar uchun mos emas")}. "Savollar → Rasmlar" bo'limida qo'lda tasdiqlashingiz mumkin.`,
      });
    }
  } catch (err) {
    if (err instanceof AiBudgetExceeded || err instanceof AiPermanentError) {
      await ctx.db.updateTable("picture_assets").set({ review: JSON.stringify({ visibleText: "", note: `AI review unavailable: ${(err as Error).message}` }) }).where("id", "=", a.id).execute();
      await alertAdmins(ctx, ctx.db, { key: `asset:${a.id}:noreview`, groupId: a.group_id, text: `🖼 Rasm #${a.id} AI tekshiruvidan o'tmadi (${escapeHtml((err as Error).message)}). Qo'lda tasdiqlang.` });
      return;
    }
    throw err;
  }
}
