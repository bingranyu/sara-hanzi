// g2pw.worker.js
import { AutoTokenizer, AutoModel, Tensor, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3';

// 關閉遠端下載，指定從 Worker 所在目錄尋找模型
env.allowRemoteModels = false; 
env.allowLocalModels = true;
env.localModelPath = './'; 

let tokenizer = null;
let model = null;
let metaData = null;

// 監聽主線程傳來的消息
self.onmessage = async function(e) {
    const { type, data, msgId } = e.data;

    if (type === 'INIT') {
        try {
            // 1. 載入元數據 (metainfo.json)
            const response = await fetch('./metainfo.json');
            metaData = await response.json();

            // 2. 載入 Tokenizer 與 ONNX 模型
            const modelPath = './albert-ws'; 
            tokenizer = await AutoTokenizer.from_pretrained(modelPath);
            model = await AutoModel.from_pretrained(modelPath);

            // 回傳成功給主線程
            self.postMessage({ type: 'INIT_SUCCESS', msgId });
        } catch (error) {
            self.postMessage({ type: 'INIT_FAIL', error: error.message, msgId });
        }
    }

    if (type === 'INFERENCE') {
        try {

            const sentences = data; // 預期為字串陣列，例如 ["重新來過", "重新來過"]
            const results = await runInference(sentences);
            
            self.postMessage({ type: 'INFERENCE_SUCCESS', result: results, msgId });
        } catch (error) {
            self.postMessage({ type: 'INFERENCE_FAIL', error: error.message, msgId });
        }
    }
};


// 核心推論邏輯
async function runInference(sentences) {
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

        const positionId = queryId + 1; // 考慮前端加上了 [CLS] 標記
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

    return partialResults;
}