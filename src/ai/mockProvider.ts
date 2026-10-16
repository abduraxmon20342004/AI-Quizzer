import { normalizeText, normalizeWord } from "../domain/normalize.js";
import type { GenerationInput, GradeInput, ReviewItemInput } from "./prompts.js";
import { AiPermanentError, type AiProvider, type StructuredRequest, type StructuredResult } from "./provider.js";
import type { GenerationOutput, GradeOutput, PictureReviewOutput, ReviewOutput } from "./schemas.js";

/**
 * Deterministic stand-in for the real model, ONLY for APP_MODE=demo|test (config refuses it in production).
 * It builds simple grounded questions from the provided sections so the full pipeline can be simulated
 * without network access or cost. Failure injection supports the timeout/pending tests.
 */
export class MockAiProvider implements AiProvider {
  readonly name = "mock";
  readonly isMock = true;
  calls: { task: string; input: unknown }[] = [];
  /** Test switch: the reviewer rejects every item (exercises bounded regeneration). */
  rejectAllReviews = false;
  private failures: { task: string; kind: "timeout" | "refusal" }[] = [];

  failNext(task: string, kind: "timeout" | "refusal", times = 1): void {
    for (let i = 0; i < times; i++) this.failures.push({ task, kind });
  }

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls.push({ task: req.task, input: req.input });
    const fi = this.failures.findIndex((f) => f.task === req.task);
    if (fi >= 0) {
      const [f] = this.failures.splice(fi, 1);
      if (f!.kind === "timeout") throw new Error("Request timed out (mock)");
      throw new AiPermanentError("model declined (mock)", "refusal");
    }
    let data: unknown;
    switch (req.task) {
      case "generate_questions":
        data = generate(req.input as GenerationInput);
        break;
      case "review_questions":
        data = review((req.input as { items: ReviewItemInput[] }).items, this.rejectAllReviews);
        break;
      case "grade_answer":
        data = grade(req.input as GradeInput);
        break;
      case "review_picture":
        data = { visibleText: "", matchesDescription: true, childSafe: true, problems: [] } satisfies PictureReviewOutput;
        break;
    }
    const parsed = req.schema.parse(data);
    return { data: parsed, model: "mock", inputTokens: 1000, outputTokens: 300 };
  }
}

const STOP = new Set(["bilan", "uchun", "hamda", "yoki", "bo'ladi", "qiladi", "boshqa", "mumkin", "kerak", "with", "that", "this", "from", "which"]);

function keyWords(sentence: string): string[] {
  return sentence
    .split(/[^\p{L}\p{N}'.]+/u)
    .map((w) => w.replace(/^[.']+|[.']+$/g, ""))
    .filter((w) => w.length >= 5 && !STOP.has(w.toLowerCase()) && !/^\d+$/.test(w));
}

function sentencesOf(sections: GenerationInput["sections"]) {
  const out: { sectionId: number; sentence: string }[] = [];
  for (const s of sections) {
    const body = s.text.split(/\n/).filter((l) => !l.trim().startsWith("#")).join(" ");
    for (const raw of body.split(/(?<=[.!?])\s+/)) {
      const sentence = raw.trim();
      if (sentence.length >= 30 && sentence.length <= 220 && keyWords(sentence).length >= 2) out.push({ sectionId: s.id, sentence });
    }
  }
  return out;
}

const CODE_BUGS = [
  { code: "const mevalar = ['olma', 'nok'];\nconsole.log(mevalar.lenght);", fixed: "const mevalar = ['olma', 'nok'];\nconsole.log(mevalar.length);", what: "lenght emas, length" },
  { code: "const sonlar = [1, 2, 3];\nsonlar.push[4];\nconsole.log(sonlar);", fixed: "const sonlar = [1, 2, 3];\nsonlar.push(4);\nconsole.log(sonlar);", what: "push metodi () bilan chaqiriladi" },
  { code: "const ranglar = ['qizil', 'yashil'];\nconsole.log(ranglar[2]);", fixed: "const ranglar = ['qizil', 'yashil'];\nconsole.log(ranglar[1]);", what: "oxirgi element indeksi 1" },
  { code: "const arr = [3, 1, 2];\nconst kv = arr.map(x => x * x)\nconsole.log(kv.join(' '))", fixed: "const arr = [3, 1, 2];\nconst kv = arr.map(x => x * x);\nconsole.log(kv.join(' '));", what: "nuqtali vergul yetishmaydi (uslub)" },
  { code: "let ism = 'Ali';\nif (ism = 'Vali') {\n  console.log('Salom Vali');\n}", fixed: "let ism = 'Ali';\nif (ism === 'Vali') {\n  console.log('Salom Vali');\n}", what: "= emas, === bilan solishtirish kerak" },
  { code: "const a = [1, 2, 3];\nfor (let i = 0; i <= a.length; i++) {\n  console.log(a[i]);\n}", fixed: "const a = [1, 2, 3];\nfor (let i = 0; i < a.length; i++) {\n  console.log(a[i]);\n}", what: "<= emas, < bo'lishi kerak" },
  { code: "const s = [5, 6];\nconsole.log(s.indexof(6));", fixed: "const s = [5, 6];\nconsole.log(s.indexOf(6));", what: "indexOf katta O bilan" },
  { code: "const x = [1, 2];\nconst y = x.concat[3];\nconsole.log(y);", fixed: "const x = [1, 2];\nconst y = x.concat([3]);\nconsole.log(y);", what: "concat() chaqiriladi" },
];

const EMOJI = [
  { emojis: "🍎🍌🍇", category: "Bir guruh narsalar", options: ["Mevalar", "Sabzavotlar", "Hayvonlar", "Ranglar"], correct: 0 },
  { emojis: "📦📦📦➡️🔢", category: "Bir nechta qiymatni bitta joyda saqlash", options: ["Massiv", "Funksiya", "Shart", "Izoh"], correct: 0 },
  { emojis: "➕📦🔚", category: "Massiv metodi", options: ["push", "pop", "shift", "slice"], correct: 0 },
  { emojis: "✂️📦🔚", category: "Massiv metodi", options: ["pop", "push", "concat", "map"], correct: 0 },
  { emojis: "🔁📦➡️🆕📦", category: "Har bir elementni o'zgartiruvchi metod", options: ["map", "push", "indexOf", "length"], correct: 0 },
  { emojis: "📏📦", category: "Massiv xossasi", options: ["length", "push", "sort", "join"], correct: 0 },
  { emojis: "🔍📦", category: "Elementni qidirish metodi", options: ["indexOf", "pop", "concat", "reverse"], correct: 0 },
  { emojis: "🔗📦📦", category: "Ikki massivni birlashtirish", options: ["concat", "split", "pop", "shift"], correct: 0 },
];

function rotate<T>(arr: T[], k: number): T[] {
  const n = arr.length;
  return arr.map((_, i) => arr[(i + k) % n]!);
}

function generate(g: GenerationInput): GenerationOutput {
  const sents = sentencesOf(g.sections);
  const avoid = new Set(g.avoid.map((a) => normalizeText(a).slice(0, 60)));
  const seed = g.avoid.length + g.feedback.length * 7;
  const items: GenerationOutput["items"] = [];
  const allWords = [...new Set(sents.flatMap((s) => keyWords(s.sentence)))];
  for (let i = 0; i < g.slots.length; i++) {
    const slot = g.slots[i]!;
    const pick = sents.length ? sents[(i * 3 + seed) % sents.length]! : null;
    const words = pick ? keyWords(pick.sentence) : [];
    const key = words.length ? words.reduce((a, b) => (b.length > a.length ? b : a)) : "massiv";
    const refs = slot.origin === "source" && pick ? { sourceSectionIds: [pick.sectionId], supportingExcerpt: pick.sentence } : { sourceSectionIds: [], supportingExcerpt: "" };
    const base = { origin: slot.origin, difficulty: slot.difficulty, ...refs };
    const distract = allWords.filter((w) => normalizeWord(w) !== normalizeWord(key)).slice((i + seed) % Math.max(1, allWords.length - 3));
    const options3 = [...distract, "funksiya", "o'zgaruvchi", "shart", "sikl"].filter((w, k, a) => a.indexOf(w) === k && normalizeWord(w) !== normalizeWord(key)).slice(0, 3);
    const ci = (i + seed) % 4;
    const options = [...options3];
    options.splice(ci, 0, key);
    switch (g.gameType) {
      case "quiz_poll": {
        const prompt = pick
          ? `Bo'sh joyni to'ldiring: "${pick.sentence.replace(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "____")}"`.slice(0, 280)
          : `Savol ${i + 1}: massiv nima?`;
        items.push({ ...base, prompt, options, correctIndex: ci, explanation: `To'g'ri javob: ${key}.` });
        break;
      }
      case "true_false": {
        const isTrue = (i + seed) % 2 === 0;
        const statement = pick ? (isTrue ? pick.sentence : pick.sentence.replace(key, options3[0] ?? "funksiya")).replace(/\?$/, ".") : "Massiv elementlari 0 dan sanaladi.";
        items.push({ ...base, statement, isTrue, explanation: isTrue ? "Bu darsda aytilgan." : `Aslida: ${pick?.sentence ?? ""}`.slice(0, 190) });
        break;
      }
      case "guess_word": {
        const clue1 = pick ? `Darsdagi gap: "${pick.sentence.replace(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "____")}"`.slice(0, 280) : "Dasturlashdagi tushuncha.";
        items.push({ ...base, answer: key, acceptedVariants: [key.toLowerCase()], clues: [clue1, `So'z ${key.length} harfdan iborat.`, `Birinchi harfi: ${key[0]!.toUpperCase()}.`], explanation: `Javob: ${key}.` });
        break;
      }
      case "find_mistake": {
        const b = CODE_BUGS[(i + seed) % CODE_BUGS.length]!;
        items.push({ ...base, prompt: "Kodda bitta xato bor. Uni tuzating.", codeLanguage: "javascript", code: b.code, fixedCode: b.fixed, acceptedFixes: [], mistakeDescription: b.what, rubric: `To'g'ri javob xatoni tuzatadi: ${b.what}. Boshqa joyni buzmasligi kerak.`, explanation: b.what });
        break;
      }
      case "emoji_puzzle": {
        const e = EMOJI[(i + seed) % EMOJI.length]!;
        const k = (i + seed) % 4;
        const opts = rotate(e.options, 4 - k);
        items.push({ ...base, emojis: e.emojis, category: e.category, options: opts, correctIndex: k, explanation: `Javob: ${e.options[e.correct]}.` });
        break;
      }
      case "picture_quiz": {
        const asset = g.assets[(i + seed) % Math.max(1, g.assets.length)];
        if (!asset) return { items, cannotGenerate: true, cannotGenerateReason: "no picture assets" };
        const answer = asset.description.split(/[,.;]/)[0]!.trim().slice(0, 28) || "Rasm";
        const opts = [answer, "Kitob", "Daraxt", "Mashina"].filter((x, k, a) => a.indexOf(x) === k).slice(0, 4);
        while (opts.length < 4) opts.push(`Variant ${opts.length + 1}`);
        items.push({ ...base, prompt: "Rasmda nima tasvirlangan?", assetId: asset.id, options: rotate(opts, 4 - (i % 4)), correctIndex: i % 4, explanation: `Rasmda: ${answer}.` });
        break;
      }
    }
    void avoid;
  }
  return { items, cannotGenerate: false, cannotGenerateReason: "" };
}

function review(items: ReviewItemInput[], rejectAll: boolean): ReviewOutput {
  return {
    reviews: items.map((it) => {
      const bad = rejectAll || JSON.stringify(it.content).includes("REJECTME");
      return {
        itemId: it.itemId,
        verdict: bad ? "reject" : "approve",
        problems: bad ? ["marked for rejection"] : [],
        singleCorrectAnswer: true,
        clearWording: !bad,
        noAnswerClue: true,
        distractorsPlausible: true,
        supportedBySource: true,
        factuallyCorrect: true,
        factualConfidence: "high",
        ageAppropriate: true,
        safe: true,
        readingLevelOk: true,
        unambiguous: true,
      };
    }),
  };
}

function grade(g: GradeInput): GradeOutput {
  const ans = normalizeText(g.studentAnswer);
  if (/ignore|instruction|ko'rsatma|correct deb|mark (this|as)|baholang|system/i.test(ans)) return { verdict: "incorrect", reason: "Not an answer attempt (manipulation)." };
  if (ans.includes("???") || ans.length === 0) return { verdict: "needs_review", reason: "Unclear answer." };
  const accepted = g.acceptedAnswers.map(normalizeText);
  if (g.gameType === "find_mistake") {
    const squash = (s: string) => s.replace(/\s+/g, "").replace(/;/g, "");
    const ok = accepted.some((a) => squash(a) === squash(ans));
    return ok ? { verdict: "correct", reason: "Equivalent fix." } : { verdict: "incorrect", reason: "Does not fix the mistake." };
  }
  if (ans.split(" ").length > Math.max(...accepted.map((a) => a.split(" ").length))) return { verdict: "needs_review", reason: "Several answers given." };
  const near = accepted.some((a) => a === ans || (a.length > 4 && (a.startsWith(ans.slice(0, a.length - 1)) || ans.startsWith(a.slice(0, a.length - 1)))));
  return near ? { verdict: "correct", reason: "Same word with a small spelling difference." } : { verdict: "incorrect", reason: "Different word." };
}
