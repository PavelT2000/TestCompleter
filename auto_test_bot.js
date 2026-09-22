require('dotenv').config();
const puppeteer = require('puppeteer-core');
const { GoogleGenAI } = require('@google/genai');

// ================= КОНФИГУРАЦИЯ =================
const API_KEY = process.env.GEMINI_API_KEY;
const CHROME_PATH = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROFILE_PATH = process.env.PROFILE_PATH || "C:\\Users\\user\\chrome-dev-profile";
const START_URL = process.env.START_URL || "https://lms.bsuir.by/login/index.php";
// ================================================

if (!API_KEY) {
    console.error("❌ Ошибка: Не задан GEMINI_API_KEY в файле .env");
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: API_KEY });

(async () => {
    console.log("🚀 Запуск браузера...");
    const browser = await puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: false,
        defaultViewport: null,
        userDataDir: PROFILE_PATH,
        args: ['--start-maximized']
    });

    const page = await browser.newPage();
    await page.goto(START_URL);
    
    console.log("⏳ Ожидание ручной авторизации и перехода к тесту...");
    console.log("Как только вы откроете первую страницу теста, скрипт продолжит работу.");

    // Ждем, пока URL не будет похож на страницу попытки
    await page.waitForFunction('window.location.href.includes("attempt.php") || window.location.href.includes("quiz")', { timeout: 0 });
    console.log("✅ Тест обнаружен! Начинаю автоматическое прохождение.");

    let hasNext = true;
    while (hasNext) {
        const qData = await page.evaluate(() => {
            const qtextElement = document.querySelector('.qtext');
            if (!qtextElement) return null;
            
            const question = qtextElement.innerText.trim();
            const answerElements = document.querySelectorAll('.answer input[type="radio"], .answer input[type="checkbox"]');
            
            const options = [];
            answerElements.forEach(el => {
                if (el.value === "-1") return;
                const id = el.id;
                const labelDiv = document.getElementById(id + '_label') || el.closest('div').querySelector('label') || el.parentElement;
                const text = labelDiv ? labelDiv.innerText.trim() : '';
                options.push({ id, text });
            });

            return { question, options };
        });

        if (!qData || !qData.question) {
            console.log("❓ Вопрос не найден на текущей странице. Возможно, это конец теста.");
            break;
        }

        console.log(`\n📝 Вопрос: ${qData.question}`);
        
        const prompt = `Ты сдаешь тест. Вот вопрос:\n\n${qData.question}\n\nВот варианты ответов:\n` + 
                       qData.options.map((o, idx) => `${idx + 1}. ${o.text}`).join('\n') + 
                       `\n\nВыбери правильный(ые) ответ(ы). Верни ТОЛЬКО номера правильных ответов (например, "1" или "2, 4"). Без лишнего текста.`;

        try {
            console.log("🧠 Спрашиваю Gemini API...");
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
            });
            
            const rawAns = response.text.trim();
            console.log(`🤖 Ответ Gemini: ${rawAns}`);

            const selectedIndexes = rawAns.match(/\d+/g)?.map(n => parseInt(n) - 1) || [];
            const idsToClick = selectedIndexes.map(idx => qData.options[idx]?.id).filter(Boolean);
            
            if (idsToClick.length > 0) {
                await page.evaluate((ids) => {
                    ids.forEach(id => {
                        const el = document.getElementById(id);
                        if (el && !el.checked) el.click();
                    });
                }, idsToClick);
                console.log(`✅ Выбраны варианты: ${selectedIndexes.map(i => i+1).join(', ')}`);
            } else {
                console.log("⚠️ Не удалось разобрать ответ от Gemini.");
            }
        } catch (e) {
            console.error("❌ Ошибка при запросе к Gemini:", e.message);
        }

        const nextBtn = await page.$('input[name="next"]');
        if (nextBtn) {
            console.log("➡️ Переход на следующую страницу...");
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
                nextBtn.click()
            ]);
            await new Promise(r => setTimeout(r, 1000));
        } else {
            console.log("🏁 Кнопка 'Далее' не найдена. Тест завершен!");
            hasNext = false;
        }
    }

    console.log("🎉 Прохождение закончено!");
})();
