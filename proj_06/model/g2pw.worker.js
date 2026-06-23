// g2pw.worker.js
import { AutoTokenizer, AutoModel, Tensor, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3';

// 關閉遠端下載，指定從 Worker 所在目錄尋找模型
env.allowRemoteModels = false; 
env.allowLocalModels = true;
env.localModelPath = './'; 

let tokenizer = null;
let model = null;
let metaData = null;
let patchData = null;

// 監聽主線程傳來的消息
self.onmessage = async function(e) {
    const { type, data, msgId } = e.data;

    if (type === 'INIT') {
        try {
            // 1. 載入 Tokenizer 與 ONNX 模型
            const modelPath = './g2pw_model_onnx'; 
            tokenizer = await AutoTokenizer.from_pretrained(modelPath);
            model = await AutoModel.from_pretrained(modelPath);
			
            // 2. 載入元數據 (metainfo.json)
            const response = await fetch(modelPath+'/metainfo.json');
            metaData = await response.json();
            
            // 3. 載入補丁資料 (g2pw_patch.json)
            const responsePatch = await fetch('./g2pw_patch.json');
            patchData = await responsePatch.json();

            // 回傳成功給主線程
            self.postMessage({ type: 'INIT_SUCCESS', msgId });
        } catch (error) {
            self.postMessage({ type: 'INIT_FAIL', error: error.message, msgId });
        }
    }

    if (type === 'INFERENCE') {
        try {
            if (!model || !tokenizer || !metaData) {
                throw new Error("模型或中介資料尚未初始化完成！");
            }

            const sentences = data; // 預期為字串陣列，例如 ["重新來過", "重新來過"]
            const results = await runInference(sentences);
            
            self.postMessage({ type: 'INFERENCE_SUCCESS', result: results, msgId });
        } catch (error) {
            self.postMessage({ type: 'INFERENCE_FAIL', error: error.message, msgId });
        }
    }
};

// 核心預處理邏輯
function prepareData(sentences) {
    const polyphonicChars = new Set(metaData.chars);
    const texts = [];
    const queryIds = [];
    const sentIds = [];
    const partialResults = [];

    sentences.forEach((sent, sentId) => {
        const partialResult = new Array(sent.length).fill(null);
        
        for (let i = 0; i < sent.length; i++) {
            const char = sent[i];
            if (polyphonicChars.has(char)) {
                texts.push(sent);
                queryIds.push(i);
                sentIds.push(sentId);
            } else if (
				/\p{Script=Han}/u.test(char) &&
				metaData.monophonic_chars[char]
			) {
				const mono = metaData.monophonic_chars[char];

				partialResult[i] = Array.isArray(mono)
					? mono[1]
					: mono;
			} else if (metaData.char_bopomofo_dict[char]) {
                partialResult[i] = metaData.char_bopomofo_dict[char][0];
            } else {
                partialResult[i] = char; // 若完全找不到對應，保留原字
            }
        }
        partialResults.push(partialResult);
    });

    return { texts, queryIds, sentIds, partialResults };
}

// 核心推論邏輯
async function runInference(sentences) {
    const { texts, queryIds, sentIds, partialResults } = prepareData(sentences);
    const batchSize = texts.length;

    // 如果輸入的文本完全沒有多音字，直接返回字典比對出的注音
    if (batchSize === 0) {
        return partialResults;
    }

    let allInputIds = [];
    let allTokenIds = [];
    let allMaskIds = [];
    let allPhonemeMasks = [];
    let allCharIds = [];
    let allPositionIds = [];

for (let idx = 0; idx < batchSize; idx++) {
        const text = texts[idx].toLowerCase();
        const queryId = queryIds[idx];

        // 呼叫 Transformers.js Tokenizer
        const encoded = await tokenizer(text, { return_tensor: 'np' });
        const inputIdsArr = Array.from(encoded.input_ids.data);
        
        allInputIds.push(inputIdsArr);
        allTokenIds.push(new Array(inputIdsArr.length).fill(0));
        allMaskIds.push(new Array(inputIdsArr.length).fill(1));

        const queryChar = text[queryId];
        const allowedPhonemes = new Set(metaData.char2phonemes[queryChar] || []);
        const phonemeMask = metaData.labels.map((_, i) => allowedPhonemes.has(i) ? 1.0 : 0.0);
        allPhonemeMasks.push(phonemeMask);

        const charId = metaData.chars.indexOf(queryChar);
        allCharIds.push(charId);

        // === 修正：動態對齊字元與 Token 的位置 ===
        const tokens = tokenizer.tokenize(text);
        let currentCharIdx = 0;
        let positionId = -1;

        for (let t = 0; t < tokens.length; t++) {
            // 自動跳過原始字串中的空格或換行
            while (currentCharIdx < text.length && (text[currentCharIdx] === ' ' || text[currentCharIdx] === '\t')) {
                currentCharIdx++;
            }
            
            // 當前比對的字元索引位置剛好是我們要找的多音字
            if (currentCharIdx === queryId) {
                positionId = t + 1; // +1 是因為 input_ids 最前面包含 [CLS] 標記
                break;
            }
            
            let token = tokens[t].toLowerCase();
            if (token.startsWith('##')) {
                token = token.slice(2);
            }
            
            if (token === '[unk]') {
                currentCharIdx += 1; // 未知字元通常佔 1 個字元長度
            } else {
                currentCharIdx += token.length; // 依據 Token 實際長度前進
            }
        }

        // 萬一極端狀況沒對齊成功（防禦性兜底），才使用舊邏輯
        if (positionId === -1) {
            positionId = queryId + 1;
        }
        // =======================================

        allPositionIds.push(positionId);
    }

    // 動態 Padding 到最大長度
    const maxSeqLen = Math.max(...allInputIds.map(arr => arr.length));
    allInputIds = allInputIds.map(arr => arr.concat(new Array(maxSeqLen - arr.length).fill(0)));
    allTokenIds = allTokenIds.map(arr => arr.concat(new Array(maxSeqLen - arr.length).fill(0)));
    allMaskIds = allMaskIds.map(arr => arr.concat(new Array(maxSeqLen - arr.length).fill(0)));

    // 封裝成 WebONNX Tensor
    const onnxInputs = {
        "input_ids": new Tensor('int64', new BigInt64Array(allInputIds.flat().map(BigInt)), [batchSize, maxSeqLen]),
        "token_type_ids": new Tensor('int64', new BigInt64Array(allTokenIds.flat().map(BigInt)), [batchSize, maxSeqLen]),
        "attention_mask": new Tensor('int64', new BigInt64Array(allMaskIds.flat().map(BigInt)), [batchSize, maxSeqLen]),
        "phoneme_mask": new Tensor('float32', new Float32Array(allPhonemeMasks.flat()), [batchSize, metaData.labels.length]),
        "char_ids": new Tensor('int64', new BigInt64Array(allCharIds.map(BigInt)), [batchSize]),
        "position_ids": new Tensor('int64', new BigInt64Array(allPositionIds.map(BigInt)), [batchSize])
    };

    // 執行 ONNX 推論
    const outputs = await model(onnxInputs);
    const probsData = outputs.probs.data;
    const numLabels = metaData.labels.length;
    const preds = [];

    // 後處理 Argmax
    for (let b = 0; b < batchSize; b++) {
        let maxVal = -1;
        let maxIdx = 0;
        for (let l = 0; l < numLabels; l++) {
            const val = probsData[b * numLabels + l];
            if (val > maxVal) {
                maxVal = val;
                maxIdx = l;
            }
        }
        preds.push(metaData.labels[maxIdx]);
    }

    // 將多音字的預測結果回填至對應的位置中
    for (let i = 0; i < batchSize; i++) {
        const sentId = sentIds[i];
        const queryId = queryIds[i];
        partialResults[sentId][queryId] = preds[i];
    }
    
    for(const k in patchData){
        for(let i=0; i<sentences.length;i++){
            const patchStart = sentences[i].indexOf(k);
            if(patchStart>=0){
                const patchLen = k.length;
                partialResults[i].splice(patchStart, patchLen, ...patchData[k]);
            }
        }
    }

    return partialResults;
}