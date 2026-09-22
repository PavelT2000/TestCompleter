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
                const url = p.url();
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

    let hasNext = true;
    while (hasNext) {
        // Извлекаем ВСЕ вопросы на текущей странице
        const questionsOnPage = await testPage.evaluate(() => {
            const qBlocks = document.querySelectorAll('.que');
            const data = [];
            
            qBlocks.forEach((block, qIndex) => {
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

                data.push({ qIndex, question, options });
            });
            return data;
        });

        if (!questionsOnPage || questionsOnPage.length === 0) {
            console.log("❓ Вопросы не найдены на текущей странице. Возможно, это конец теста.");
            break;
        }

        console.log(`\n📋 Найдено вопросов на странице: ${questionsOnPage.length}`);

        // Разбиваем вопросы на пачки по 30 штук, чтобы не перегружать API
        const chunkSize = 30;
        for (let i = 0; i < questionsOnPage.length; i += chunkSize) {
            const chunk = questionsOnPage.slice(i, i + chunkSize);
            console.log(`\n⚙️ Обработка вопросов с ${i + 1} по ${i + chunk.length}...`);

            // Формируем JSON-запрос для Gemini
            const promptData = chunk.map((q, idx) => {
                return `Вопрос ${idx}:\n${q.question}\nВарианты:\n` + 
                       q.options.map((o, oIdx) => `${oIdx}. ${o.text}`).join('\n');
            }).join('\n\n---\n\n');

            const prompt = `Ты эксперт по тестированию и IT. Реши следующие тестовые вопросы.
Вот список вопросов и вариантов ответов:

${promptData}

Верни результат СТРОГО в формате JSON-массива, где каждый элемент имеет вид:
{
  "q": номер_вопроса_начиная_с_0,
  "a": [массив_индексов_правильных_вариантов_начиная_с_0]
}
Никакого лишнего текста, только валидный JSON.`;

            try {
                console.log("🧠 Отправляю запрос к Gemini API...");
                const response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: prompt,
                });
                
                let rawAns = response.text.trim();
                // Убираем маркдаун для json если он есть
                if (rawAns.startsWith('```json')) rawAns = rawAns.replace(/```json/g, '').replace(/```/g, '').trim();
                if (rawAns.startsWith('```')) rawAns = rawAns.replace(/```/g, '').trim();

                const parsedAnswers = JSON.parse(rawAns);
                console.log(`🤖 Ответ получен и успешно разобран.`);

                // Кликаем по ответам для текущего чанка
                const idsToClick = [];
                parsedAnswers.forEach(ans => {
                    const localQIndex = ans.q;
                    const selectedOptions = ans.a;
                    if (chunk[localQIndex]) {
                        selectedOptions.forEach(optIdx => {
                            const optId = chunk[localQIndex].options[optIdx]?.id;
                            if (optId) idsToClick.push(optId);
                        });
                    }
                });

                if (idsToClick.length > 0) {
                    await testPage.evaluate((ids) => {
                        ids.forEach(id => {
                            const el = document.getElementById(id);
                            if (el && !el.checked) el.click();
                        });
                    }, idsToClick);
                    console.log(`✅ Выбраны варианты для ${chunk.length} вопросов.`);
                }
            } catch (e) {
                console.error("❌ Ошибка при запросе/парсинге Gemini:", e.message);
                console.log("Ответ от API был:", response ? response.text : "пусто");
            }
        }

        // Жмем "Следующая страница"
        const nextBtn = await testPage.$('input[name="next"]');
        if (nextBtn) {
            console.log("➡️ Переход на следующую страницу...");
            await Promise.all([
                testPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
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
