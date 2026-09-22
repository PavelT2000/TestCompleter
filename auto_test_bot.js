require('dotenv').config();
const puppeteer = require('puppeteer-core');
const { GoogleGenAI } = require('@google/genai');

// ================= КОНФИГУРАЦИЯ =================
const API_KEY = process.env.GEMINI_API_KEY;
const CHROME_PATH = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROFILE_PATH = process.env.PROFILE_PATH || "C:\\Users\\user\\chrome-dev-profile";
const START_URL = process.env.START_URL || "https://lms.bsuir.by/login/index.php";
// ================================================

// Логирование в файл для удобного дебага
const fs = require('fs');
const util = require('util');
const logFile = fs.createWriteStream('bot_debug.log', { flags: 'w' });
const originalLog = console.log;
const originalError = console.error;
console.log = function () {
    logFile.write(util.format.apply(null, arguments) + '\n');
    originalLog.apply(console, arguments);
};
console.error = function () {
    logFile.write(util.format.apply(null, arguments) + '\n');
    originalError.apply(console, arguments);
};

if (!API_KEY) {
    console.error("❌ Ошибка: Не задан GEMINI_API_KEY в файле .env");
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: API_KEY });

(async () => {
    let browser;
    try {
        const fs = require('fs');
        const path = require('path');
        const activePortFile = path.join(PROFILE_PATH, 'DevToolsActivePort');
        let port = '9222';
        if (fs.existsSync(activePortFile)) {
            const lines = fs.readFileSync(activePortFile, 'utf8').split('\n');
            port = lines[0].trim();
        }
        
        console.log(`Пытаюсь подключиться к уже открытому браузеру на порту ${port}...`);
        browser = await puppeteer.connect({
            browserURL: `http://127.0.0.1:${port}`,
            defaultViewport: null
        });
        console.log("✅ Успешно подключено к открытому браузеру!");
    } catch (e) {
        console.log("🚀 Открытого браузера с отладкой не найдено. Запуск нового окна Chrome...");
        browser = await puppeteer.launch({
            executablePath: CHROME_PATH,
            headless: false,
            defaultViewport: null,
            userDataDir: PROFILE_PATH,
            args: ['--start-maximized']
        });
    }

    const pages = await browser.pages();
    let page = pages.length > 0 ? pages[0] : await browser.newPage();
    
    // Переходим только если мы в пустой вкладке
    if (!page.url().includes('attempt') && !page.url().includes('quiz')) {
        await page.goto(START_URL);
    }
    
    console.log("⏳ Ожидание ручной авторизации и перехода к тесту...");
    console.log("Как только вы откроете первую страницу теста (даже если она откроется в новом окне), скрипт продолжит работу.");

    let testPage = null;
    while (!testPage) {
        const pages = await browser.pages();
        for (const p of pages) {
            try {
                const url = p.target().url();
                if (url.includes("attempt.php") || url.includes("quiz")) {
                    const hasQuestion = await p.evaluate(() => !!document.querySelector('.que'));
                    if (hasQuestion) {
                        testPage = p;
                        break;
                    }
                }
            } catch (e) {}
        }
        if (!testPage) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    await testPage.bringToFront();
    console.log("✅ Тест обнаружен! Начинаю автоматическое прохождение.");

    // ================= ФАЗА 1: СБОР ВСЕХ ВОПРОСОВ =================
    console.log("🔍 ФАЗА 1: Собираю все вопросы со всех страниц теста...");
    
    // Принудительно идем на первую страницу (чтобы не пропустить вопросы, если тест открылся с середины)
    let startUrl = testPage.target().url();
    if (startUrl.includes("attempt.php")) {
        let firstPageUrl;
        if (startUrl.includes("page=")) {
            firstPageUrl = startUrl.replace(/page=\d+/, 'page=0');
        } else {
            firstPageUrl = startUrl + "&page=0";
        }
        if (startUrl !== firstPageUrl && !startUrl.includes("page=0")) {
            console.log("⏪ Обнаружено, что мы не в начале. Возвращаюсь на первую страницу...");
            await testPage.goto(firstPageUrl, { waitUntil: 'domcontentloaded' });
        }
    }

    const allQuestions = [];
    
    let scraping = true;
    while (scraping) {
        const currentUrl = testPage.target().url();
        if (currentUrl.includes("summary.php")) {
            console.log("Дошли до конца теста при сборе.");
            break;
        }

        const questionsOnPage = await testPage.evaluate(() => {
            const qBlocks = document.querySelectorAll('.que');
            const data = [];
            qBlocks.forEach((block) => {
                const qtextElement = block.querySelector('.qtext');
                if (!qtextElement) return;
                
                const question = qtextElement.innerText.trim();
                const answerElements = block.querySelectorAll('.answer input[type="radio"], .answer input[type="checkbox"]');
                
                const options = [];
                answerElements.forEach(el => {
                    if (el.value === "-1") return;
                    const id = el.id;
                    const labelDiv = document.getElementById(id + '_label') || el.closest('div').querySelector('label') || el.parentElement;
                    const text = labelDiv ? labelDiv.innerText.trim() : '';
                    options.push({ id, text });
                });

                data.push({ question, options });
            });
            return data;
        });

        if (questionsOnPage && questionsOnPage.length > 0) {
            questionsOnPage.forEach(q => allQuestions.push({ url: currentUrl, ...q }));
            console.log(`Собрано ${questionsOnPage.length} вопросов с текущей страницы. Всего: ${allQuestions.length}`);
        }

        const nextBtn = await testPage.$('input[name="next"]');
        if (nextBtn) {
            await Promise.all([
                testPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
                nextBtn.click()
            ]);
            await new Promise(r => setTimeout(r, 500));
        } else {
            scraping = false;
        }
    }

    if (allQuestions.length === 0) {
        console.log("❌ Вопросы не найдены. Остановка.");
        process.exit(1);
    }

    // ================= ФАЗА 2: ЗАПРОСЫ К GEMINI =================
    console.log(`\n🧠 ФАЗА 2: Отправка ${allQuestions.length} вопросов в Gemini (пачками до 30 штук)...`);
    const allIdsToClick = []; // Соберем все ID инпутов, которые нужно прокликать

    const chunkSize = 30;
    for (let i = 0; i < allQuestions.length; i += chunkSize) {
        const chunk = allQuestions.slice(i, i + chunkSize);
        console.log(`Отправка пачки с ${i + 1} по ${i + chunk.length}...`);

        const promptData = chunk.map((q, idx) => {
            return `Вопрос ${idx}:\n${q.question}\nВарианты:\n` + 
                   q.options.map((o, oIdx) => `${oIdx}. ${o.text}`).join('\n');
        }).join('\n\n---\n\n');

        const prompt = `Ты эксперт по тестированию и IT. Реши следующие тестовые вопросы.
Вот список вопросов:
${promptData}

Верни результат СТРОГО в формате JSON-массива, где каждый элемент имеет вид:
{
  "q": номер_вопроса_начиная_с_0,
  "a": [массив_индексов_правильных_вариантов_начиная_с_0]
}
Никакого лишнего текста, только валидный JSON.`;

        try {
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
            });
            
            let rawAns = response.text.trim();
            if (rawAns.startsWith('```json')) rawAns = rawAns.replace(/```json/g, '').replace(/```/g, '').trim();
            if (rawAns.startsWith('```')) rawAns = rawAns.replace(/```/g, '').trim();

            const parsedAnswers = JSON.parse(rawAns);
            
            parsedAnswers.forEach(ans => {
                const localQIndex = ans.q;
                const selectedOptions = ans.a;
                if (chunk[localQIndex]) {
                    selectedOptions.forEach(optIdx => {
                        const optId = chunk[localQIndex].options[optIdx]?.id;
                        if (optId) allIdsToClick.push(optId);
                    });
                }
            });
            console.log(`✅ Пачка успешно обработана.`);
        } catch (e) {
            console.error("❌ Ошибка при запросе/парсинге Gemini:", e.message);
        }
    }

    // ================= ФАЗА 3: ПРОКЛИКИВАНИЕ ОТВЕТОВ =================
    console.log(`\n🖱️ ФАЗА 3: Возвращаемся в начало и проставляем ответы...`);
    
    // Идем на первую страницу с вопросами
    await testPage.goto(allQuestions[0].url, { waitUntil: 'domcontentloaded' });
    
    let applying = true;
    while (applying) {
        if (testPage.target().url().includes("summary.php")) {
            break;
        }

        // Кликаем нужные ID на этой странице
        await testPage.evaluate((ids) => {
            ids.forEach(id => {
                const el = document.getElementById(id);
                if (el && !el.checked) el.click();
            });
        }, allIdsToClick);

        // Небольшая пауза для срабатывания AJAX (сохранения ответа)
        await new Promise(r => setTimeout(r, 600));

        const nextBtn = await testPage.$('input[name="next"]');
        if (nextBtn) {
            await Promise.all([
                testPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
                nextBtn.click()
            ]);
            await new Promise(r => setTimeout(r, 500));
        } else {
            applying = false;
        }
    }

    console.log("🎉 Прохождение закончено! Проверьте страницу сводки.");
})();
