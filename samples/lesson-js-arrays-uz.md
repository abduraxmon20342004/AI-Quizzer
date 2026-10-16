# JavaScript massivlari

Massiv bir nechta qiymatni bitta o'zgaruvchida tartib bilan saqlaydigan tuzilma. Massiv kvadrat qavslar ichida yoziladi va elementlar vergul bilan ajratiladi. Masalan, mevalar ro'yxatini quyidagicha yozish mumkin: const mevalar = ['olma', 'nok', 'uzum'].

Massiv elementlari indeks orqali olinadi. JavaScriptda indekslar noldan boshlanadi, shuning uchun birinchi elementning indeksi 0 ga teng. mevalar[0] yozuvi 'olma' qiymatini qaytaradi, mevalar[2] esa 'uzum' qiymatini qaytaradi.

## Massiv uzunligi

Massivdagi elementlar sonini length xossasi ko'rsatadi. mevalar.length qiymati 3 ga teng. Oxirgi elementning indeksi har doim length dan bitta kam bo'ladi. Shuning uchun oxirgi elementni olish uchun mevalar[mevalar.length - 1] yoziladi.

## Element qo'shish va olib tashlash

push metodi massiv oxiriga yangi element qo'shadi. Masalan, mevalar.push('anor') chaqirilgandan keyin massivda to'rtta element bo'ladi. pop metodi esa massivning oxirgi elementini olib tashlaydi va shu elementni qaytaradi.

unshift metodi massiv boshiga element qo'shadi. shift metodi massivning birinchi elementini olib tashlaydi. Bu metodlar massivning o'zini o'zgartiradi, shuning uchun ularni ehtiyotkorlik bilan ishlatish kerak.

## Qidirish

indexOf metodi berilgan qiymatning massivdagi indeksini qaytaradi. Agar qiymat topilmasa, indexOf metodi -1 qaytaradi. includes metodi esa qiymat massivda bor yoki yo'qligini true yoki false ko'rinishida bildiradi.

## Massivlarni aylanib chiqish

for sikli yordamida massivning har bir elementini ko'rib chiqish mumkin. Siklda hisoblagich 0 dan boshlanadi va length dan kichik bo'lguncha davom etadi. Agar shart i <= length deb yozilsa, sikl bir marta ortiqcha aylanadi va undefined qiymatini beradi.

forEach metodi har bir element uchun berilgan funksiyani chaqiradi. map metodi esa har bir elementni o'zgartirib, yangi massiv qaytaradi. map asl massivni o'zgartirmaydi.

## Massivlarni birlashtirish va qism olish

concat metodi ikki massivni birlashtirib, yangi massiv yaratadi. slice metodi massivning bir qismini nusxa qilib oladi va asl massivni o'zgartirmaydi. join metodi esa massiv elementlarini bitta satrga birlashtiradi, masalan ['a', 'b'].join('-') natijasi 'a-b' bo'ladi.

## Saralash

sort metodi massiv elementlarini tartiblaydi. Sonlarni to'g'ri tartiblash uchun sort metodiga taqqoslash funksiyasi beriladi, masalan sonlar.sort((a, b) => a - b). reverse metodi elementlar tartibini teskarisiga o'zgartiradi.
