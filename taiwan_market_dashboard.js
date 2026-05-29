// Taiwan Future Market Daily - JavaScript port of TaiwanFutureMarketDaily.cs

// TAIFEX blocks browser CORS. Never call taifex.com.tw directly from the browser.
const LOCAL_PROXY = 'http://127.0.0.1:8080/proxy?url=';
const CORS_PROXIES = [
    (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

function getPreviousBusinessDay(fromDate = new Date()) {
    const d = new Date(fromDate);
    d.setDate(d.getDate() - 1);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
    return d;
}

function formatTwseDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
}

function formatDisplayDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function formatSlashDate(date) {
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

function parseNumber(text) {
    if (!text) return 0;
    const cleaned = String(text).replace(/,/g, '').replace(/%/g, '').replace(/\+/g, '').replace(/\s/g, '').trim();
    const value = parseFloat(cleaned);
    return Number.isNaN(value) ? 0 : value;
}

function formatNumber(num) {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatDecimal(num, digits) {
    return formatNumber(num.toFixed(digits));
}

function signedPrefix(num) {
    return num > 0 ? '+' : '';
}

function mustUseProxy(url) {
    return url.includes('taifex.com.tw') || window.location.protocol === 'file:';
}

async function fetchFromUrl(fetchUrl) {
    const response = await fetch(fetchUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (!text || text.trim().length === 0) throw new Error('Empty response');
    return text;
}

async function fetchViaProxy(url) {
    const attempts = [
        () => fetchFromUrl(LOCAL_PROXY + encodeURIComponent(url)),
        ...CORS_PROXIES.map(build => () => fetchFromUrl(build(url))),
    ];

    let lastError;
    for (const attempt of attempts) {
        try {
            return await attempt();
        } catch (err) {
            lastError = err;
            console.warn('Proxy attempt failed:', err.message);
        }
    }
    throw lastError || new Error('All CORS proxies failed');
}

async function fetchWithRetry(url, retries = 3) {
    let lastError;
    for (let i = 0; i < retries; i++) {
        try {
            if (mustUseProxy(url)) {
                return await fetchViaProxy(url);
            }
            try {
                return await fetchFromUrl(url);
            } catch {
                return await fetchViaProxy(url);
            }
        } catch (err) {
            lastError = err;
            console.warn(`Retry ${i + 1} for ${url}:`, err.message);
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    throw lastError;
}

async function getForeignNetBuySell(date) {
    const url = `https://www.twse.com.tw/fund/BFI82U?date=${formatTwseDate(date)}&response=json`;
    const json = await fetchWithRetry(url);
    const doc = JSON.parse(json);
    for (const row of doc.data) {
        const name = row[0] || '';
        if (name.includes('外資及陸資')) {
            return parseNumber(row[row.length - 1] || '0') / 100000000;
        }
    }
    return 0;
}

async function getTaiex(date) {
    const url = `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${formatTwseDate(date)}&type=ALLBUT0999&response=json`;
    const json = await fetchWithRetry(url);
    const doc = JSON.parse(json);
    for (const table of doc.tables) {
        if (!table.data) continue;
        for (const row of table.data) {
            if (row.length < 2) continue;
            if ((row[0] || '').includes('發行量加權股價指數')) {
                return parseNumber(row[1] || '0');
            }
        }
    }
    return 0;
}

async function getPcRatio(date) {
    const html = await fetchWithRetry('https://www.taifex.com.tw/cht/3/pcRatioExcel');
    const targetDate = formatSlashDate(date);
    const escaped = targetDate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
        `<td align="center">${escaped}</td>\\s*<td align="center">[\\d,]+</td>\\s*<td align="center">[\\d,]+</td>\\s*<td align="center">[\\d.]+</td>\\s*<td align="center">[\\d,]+</td>\\s*<td align="center">[\\d,]+</td>\\s*<td align="center">([\\d.]+)</td>`
    );
    const match = html.match(pattern);
    return match ? parseNumber(match[1]) / 100.0 : 0;
}

async function getTaiwanVix(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const targetDate = formatTwseDate(date);
    const url = `https://www.taifex.com.tw/file/taifex/Dailydownload/vix/log2data/${y}${m}new.txt`;
    const content = await fetchWithRetry(url);
    for (const line of content.split(/[\n\r]+/).filter(l => l.trim())) {
        if (line.startsWith('交易日期') || line.startsWith('--------')) continue;
        const parts = line.split('\t');
        if (parts.length >= 5 && parts[0].trim() === targetDate) {
            return parseNumber(parts[4].trim());
        }
    }
    return 0;
}

function extractNetPosition(html, productName) {
    const productIndex = html.indexOf(productName);
    if (productIndex === -1) return 0;
    const foreignIndex = html.indexOf('外資', productIndex);
    if (foreignIndex === -1) return 0;

    const blueNumbers = [];
    let searchPos = foreignIndex;
    const tag = '<font color="blue">';

    while (true) {
        const blueStart = html.indexOf(tag, searchPos);
        if (blueStart === -1) break;
        const valueStart = blueStart + tag.length;
        const valueEnd = html.indexOf('</font>', valueStart);
        if (valueEnd !== -1) {
            blueNumbers.push(parseNumber(html.substring(valueStart, valueEnd).replace(/[,\s]/g, '')));
        }
        searchPos = blueStart + 1;
    }
    return blueNumbers.length >= 6 ? blueNumbers[5] : 0;
}

async function getForeignNetPosition() {
    const html = (await fetchWithRetry('https://www.taifex.com.tw/cht/3/futContractsDateExcel')).replace(/\s+/g, ' ');
    const tx = extractNetPosition(html, '臺股期貨');
    const mx = extractNetPosition(html, '小型臺指期貨');
    const mtx = extractNetPosition(html, '微型臺指期貨');
    return { tx, mx, mtx, total: tx + (mx / 4) + (mtx / 20) };
}

function extractValue(html, optionType, investor, index) {
    const productIndex = html.indexOf('臺指選擇權');
    if (productIndex === -1) return 0;
    const optionIndex = html.indexOf(optionType, productIndex);
    if (optionIndex === -1) return 0;
    const investorIndex = html.indexOf(investor, optionIndex);
    if (investorIndex === -1) return 0;

    const numbers = [];
    let searchPos = investorIndex;
    const numPattern = />([-]?[\d,]+)</g;

    for (let i = 0; i < 20; i++) {
        const slice = html.substring(searchPos, Math.min(searchPos + 500, html.length));
        numPattern.lastIndex = 0;
        const match = numPattern.exec(slice);
        if (!match) break;
        const num = parseInt(match[1].replace(/,/g, ''), 10);
        if (!Number.isNaN(num)) numbers.push(num);
        searchPos += match.index + match[0].length;
    }
    return numbers.length > index ? numbers[index] : 0;
}

async function getOptionValue() {
    const html = await fetchWithRetry('https://www.taifex.com.tw/cht/3/callsAndPutsDateExcel');
    const callBuy = extractValue(html, '買權', '外資', 5);
    const callSell = extractValue(html, '買權', '外資', 6);
    const putBuy = extractValue(html, '賣權', '外資', 5);
    const putSell = extractValue(html, '賣權', '外資', 6);
    return ((callBuy + putSell) - (callSell + putBuy)) * 1000;
}

function showLoader(ids) {
    ids.forEach(id => {
        document.getElementById(id).innerHTML = '<span class="loader w-6 h-6"></span>';
    });
}

function updateUI(id, value, isPositive = null) {
    const el = document.getElementById(id);
    if (value === 'error') {
        el.innerHTML = '<span class="text-red-400 text-lg">讀取失敗</span>';
        return;
    }
    el.innerText = value;
    if (isPositive === true) {
        el.classList.remove('text-rose-400', 'text-white', 'text-purple-400', 'text-blue-400');
        el.classList.add('text-emerald-400');
    } else if (isPositive === false) {
        el.classList.remove('text-emerald-400', 'text-white', 'text-purple-400', 'text-blue-400');
        el.classList.add('text-rose-400');
    }
}

function showAlert(message) {
    document.getElementById('alertMessage').innerHTML = `<i class="fa-solid fa-triangle-exclamation mr-1"></i> ${message}`;
    document.getElementById('alertBox').classList.remove('hidden');
}

function hideAlert() {
    document.getElementById('alertBox').classList.add('hidden');
}

let tradingDate = getPreviousBusinessDay();
document.getElementById('dateDisplay').innerText = formatDisplayDate(tradingDate);

async function fetchData() {
    const valueIds = ['val-taiex', 'val-foreign-stock', 'val-pc-ratio', 'val-vix', 'val-futures', 'val-options'];
    showLoader(valueIds);
    document.getElementById('val-tx').innerText = '-';
    document.getElementById('val-mtx').innerText = '-';
    document.getElementById('val-tmf').innerText = '-';
    hideAlert();

    const btn = document.getElementById('refreshBtn');
    btn.disabled = true;
    tradingDate = getPreviousBusinessDay();
    document.getElementById('dateDisplay').innerText = formatDisplayDate(tradingDate);

    const errors = [];
    try {
        const [foreign, taiex, pcRatio, vix, futures, options] = await Promise.allSettled([
            getForeignNetBuySell(tradingDate),
            getTaiex(tradingDate),
            getPcRatio(tradingDate),
            getTaiwanVix(tradingDate),
            getForeignNetPosition(),
            getOptionValue()
        ]);
       

        if (taiex.status === 'fulfilled') updateUI('val-taiex', formatDecimal(taiex.value, 2));
        else { updateUI('val-taiex', 'error'); errors.push('加權指數'); }

        if (foreign.status === 'fulfilled') updateUI('val-foreign-stock', signedPrefix(foreign.value) + formatDecimal(foreign.value, 2), foreign.value > 0);
        else { updateUI('val-foreign-stock', 'error'); errors.push('外資買賣超'); }

        if (pcRatio.status === 'fulfilled') updateUI('val-pc-ratio', formatDecimal(pcRatio.value, 3));
        else { updateUI('val-pc-ratio', 'error'); errors.push('P/C Ratio'); }

        if (vix.status === 'fulfilled') updateUI('val-vix', formatDecimal(vix.value, 2));
        else { updateUI('val-vix', 'error'); errors.push('Taiwan VIX'); }

        if (futures.status === 'fulfilled') {
            const f = futures.value;
            document.getElementById('val-tx').innerText = formatNumber(f.tx);
            document.getElementById('val-mtx').innerText = formatNumber(f.mx);
            document.getElementById('val-tmf').innerText = formatNumber(f.mtx);
            updateUI('val-futures', formatDecimal(f.total, 2), f.total > 0);
        } else { updateUI('val-futures', 'error'); errors.push('期貨淨額'); }

        if (options.status === 'fulfilled') updateUI('val-options', '$' + formatNumber(options.value), options.value > 0);
        else { updateUI('val-options', 'error'); errors.push('選擇權淨額'); }

        if (errors.length > 0) {
            showAlert(`部分資料讀取失敗（${errors.join('、')}）。期交所不允許瀏覽器直接存取，請執行 <code class="bg-slate-800 px-1 rounded">python d:\\taiwan_market_server.py</code> 後開啟 http://127.0.0.1:8080/`);
        }
    } catch (err) {
        console.error(err);
        showAlert(`資料讀取失敗：${err.message}。請執行 python d:\\taiwan_market_server.py 啟動本機代理。`);
        valueIds.forEach(id => updateUI(id, 'error'));
    } finally {
        btn.disabled = false;
    }
}

document.getElementById('refreshBtn').addEventListener('click', fetchData);
window.addEventListener('load', fetchData);

