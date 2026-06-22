function splitTextHierarchy(text) {
	if (!text || typeof text !== 'string') return [];

	// 依據換行符號切割成段落，並移除空行
	const paragraphs = text.split(/\r?\n/).filter(p => p.trim() !== '');

	// 將每個段落切割成句子
	return paragraphs.map(paragraph => {
		// 利用正規表達式正向後瞻 (?<=...)，依據 。！、？ 斷句並保留符號
		const sentences = paragraph.split(/(?<=[。！？])/);
		return sentences.map(s => s.trim()).filter(s => s !== '');
	});
}

// 單句對齊詞與
/**
 * 4. 斷詞與注音對齊功能 (字數精準消耗版 - 完美解決中英文錯位)
 * @param {string[]} vocabs 詞彙陣列
 * @param {string[]} bopomofos 單字注音陣列
 * @returns {Object[]} 對齊後的物件陣列
 */
function alignVocabAndBopomofo(vocabs, bopomofos) {
    const result = [];
    let bopomofoIdx = 0;

    for (const vocab of vocabs) {
        if (vocab === '') continue;

        const slicedBopomofo = [];
        // 計算這個詞彙有多少個「非空白字元」需要被對齊
        const requiredCharsCount = vocab.replace(/\s+/g, '').length;

        if (requiredCharsCount === 0) {
            // 情況 A: 該詞彙本身完全由空白組成 (例如 WS 斷出獨立的空白)
            // 則從注音陣列中精準消耗掉對應數量的空白
            let spacesToConsume = vocab.length;
            while (spacesToConsume > 0 && bopomofoIdx < bopomofos.length) {
                slicedBopomofo.push(bopomofos[bopomofoIdx]);
                if (bopomofos[bopomofoIdx] === ' ') {
                    spacesToConsume--;
                } else {
                    // 如果這時候注音陣列不是空白，代表結構有極端異常，但為了防呆還是扣除並前進
                    spacesToConsume--;
                }
                bopomofoIdx++;
            }
        } else {
            // 情況 B: 一般詞彙 (中文、英文、標點符號)
            let consumedCharsCount = 0;

            while (bopomofoIdx < bopomofos.length && consumedCharsCount < requiredCharsCount) {
                const currentBopo = bopomofos[bopomofoIdx];
                slicedBopomofo.push(currentBopo);
                bopomofoIdx++;

                // 核心邏輯：
                // 如果注音陣列裡遇到的是純空白 " "，它不佔用實際字元的注音配額，
                // 我們直接把它收進來（例如 DNA 前面的空格），但 `consumedCharsCount` 不加 1。
                if (currentBopo !== ' ') {
                    consumedCharsCount++;
                }
            }
        }

        result.push({
            vocab: vocab,
            bopomo: slicedBopomofo
        });
    }

    return result;
}

async function preprocessArticle(text, ws, g2pw) {
    if (!text || typeof text !== 'string') return [];

    // 步驟 A: 切割文章，取得二維結構 [段落 [句子, ...]]
    const paragraphStructure = splitTextHierarchy(text);

    // 步驟 B: 將所有句子攤平成一維陣列，以便餵給模型進行 Batch 處理
    const flattenedSentences = [];
    for (const paragraph of paragraphStructure) {
        for (const sentence of paragraph) {
            flattenedSentences.push(sentence);
        }
    }

    // 如果文章沒有有效內容，直接回傳空陣列
    if (flattenedSentences.length === 0) return [];


    // 步驟 C: 批量取得所有句子的斷詞與注音結果 (一維陣列)
    const allWsResults = await ws.getws(flattenedSentences);
    const allBopomofoResults = await g2pw.getBopomofo(flattenedSentences);

    // 步驟 D: 將斷詞與注音進行對齊，組合成一維的「已對齊句子陣列」
    const allAlignedSentences = flattenedSentences.map((_, index) => {
        return alignVocabAndBopomofo(allWsResults[index], allBopomofoResults[index]);
    });

    // 步驟 E: 依據原始的段落與句子結構，將一維結果還原（Reconstruct）成四維陣列
    let sentencePointer = 0; // 用來追蹤目前處理到的一維陣列索引
    
    const finalArticleStructure = paragraphStructure.map(paragraph => {
        return paragraph.map(() => {
            // 取出目前指到的對齊句子，並將指標往後推
            const alignedSentence = allAlignedSentences[sentencePointer];
            sentencePointer++;
            return alignedSentence;
        });
    });

    return finalArticleStructure;
}

class G2PWClient {
	constructor(workerScriptPath = './model/g2pw.worker.js') {
		this.worker = new Worker(workerScriptPath, { type: 'module' });
		this.callbacks = new Map();
		this.msgIdCounter = 0;

		// 處理從 Worker 回傳的所有消息
		this.worker.onmessage = (e) => {
			const { type, result, error, msgId } = e.data;
			if (!this.callbacks.has(msgId)) return;

			const { resolve, reject } = this.callbacks.get(msgId);
			this.callbacks.delete(msgId); // 釋放記憶體

			if (type === 'INIT_SUCCESS') resolve({ status: 'success', message: '模型初始化成功' });
			else if (type === 'INIT_FAIL') reject(new Error(error));
			else if (type === 'INFERENCE_SUCCESS') resolve(result);
			else if (type === 'INFERENCE_FAIL') reject(new Error(error));
		};
	}

	// 接口 1: 初始化並載入模型 (回傳 Promise，支援 async/await 與 callback)
	async initModel(callback = null) {
		const msgId = this.msgIdCounter++;
		return new Promise((resolve, reject) => {
			this.callbacks.set(msgId, {
				resolve: (res) => {
					if (callback) callback(null, res);
					resolve(res);
				},
				reject: (err) => {
					if (callback) callback(err, null);
					reject(err);
				}
			});
			this.worker.postMessage({ type: 'INIT', msgId });
		});
	}

	// 接口 2: 輸入字串陣列，回傳注音符號陣列
	async getBopomofo(sentences) {
		if (!Array.isArray(sentences)) {
			throw new Error("輸入格式錯誤，必須為字串組成的 Array");
		}
		const msgId = this.msgIdCounter++;
		return new Promise((resolve, reject) => {
			this.callbacks.set(msgId, { resolve, reject });
			this.worker.postMessage({ type: 'INFERENCE', data: sentences, msgId });
		});
	}
}

class WSClient {
	constructor(workerScriptPath = './model/ws.worker.js') {
		this.worker = new Worker(workerScriptPath, { type: 'module' });
		this.callbacks = new Map();
		this.msgIdCounter = 0;

		// 處理從 Worker 回傳的所有消息
		this.worker.onmessage = (e) => {
			const { type, result, error, msgId } = e.data;
			if (!this.callbacks.has(msgId)) return;

			const { resolve, reject } = this.callbacks.get(msgId);
			this.callbacks.delete(msgId); // 釋放記憶體

			if (type === 'INIT_SUCCESS') resolve({ status: 'success', message: '模型初始化成功' });
			else if (type === 'INIT_FAIL') reject(new Error(error));
			else if (type === 'INFERENCE_SUCCESS') resolve(result);
			else if (type === 'INFERENCE_FAIL') reject(new Error(error));
		};
	}

	// 接口 1: 初始化並載入模型 (回傳 Promise，支援 async/await 與 callback)
	async initModel(callback = null) {
		const msgId = this.msgIdCounter++;
		return new Promise((resolve, reject) => {
			this.callbacks.set(msgId, {
				resolve: (res) => {
					if (callback) callback(null, res);
					resolve(res);
				},
				reject: (err) => {
					if (callback) callback(err, null);
					reject(err);
				}
			});
			this.worker.postMessage({ type: 'INIT', msgId });
		});
	}

	// 接口 2: 輸入字串陣列，回傳斷詞陣列
	async getws(sentences) {
		if (!Array.isArray(sentences)) {
			throw new Error("輸入格式錯誤，必須為字串組成的 Array");
		}
		const msgId = this.msgIdCounter++;
		return new Promise((resolve, reject) => {
			this.callbacks.set(msgId, { resolve, reject });
			this.worker.postMessage({ type: 'INFERENCE', data: sentences, msgId });
		});
	}
}

export {G2PWClient, WSClient, preprocessArticle };