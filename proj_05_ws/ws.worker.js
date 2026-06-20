// ws.worker.js
import { AutoTokenizer, AutoModel, Tensor, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3';

// 關閉遠端下載，指定從 Worker 所在目錄尋找模型
env.allowRemoteModels = false; 
env.allowLocalModels = true;
env.localModelPath = './'; 

let tokenizer = null;
let model = null;

// 監聽主線程傳來的消息
self.onmessage = async function(e) {
    const { type, data, msgId } = e.data;
    
    if (type === 'INIT') {
        try {
            // 2. 載入 Tokenizer 與 ONNX 模型
            const modelPath = 'albert-ws'; 
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
            const sentences = data; // 預期為字串陣列，例如 ["台北天氣如何?", "今天是晴天"]
            const results = await runInference(sentences);            
            self.postMessage({ type: 'INFERENCE_SUCCESS', result: results, msgId });
        } catch (error) {
            self.postMessage({ type: 'INFERENCE_FAIL', error: error.message, msgId });
        }
    }
};

function decodeBIOSegmentation(allTokens, outputData) {
    const { dims, data } = outputData.logits;
    const [batchSize, seqLen, numClasses] = dims;
    
    const labelMap = { 0: 'B', 1: 'I' };
    const finalResult = [];

    // 依序處理每一筆 Batch 資料
    for (let b = 0; b < batchSize; b++) {
        const tokens = allTokens[b]; // 取得該句子的所有 Tokens (例如: ["[CLS]", "台", "北", ...])
        const res = [];
        let word = "";

        // 遍歷該句子的每個序列位置 (最高不超過陣列長度與 seqLen 的最小值)
        const currentSeqLen = Math.min(seqLen, tokens.length);
        for (let i = 0; i < currentSeqLen; i++) {
            let t = tokens[i];

            // 1. 跳過特殊符號
            if (['[CLS]', '[SEP]', '[PAD]'].includes(t)) {
                continue;
            }

            // 2. 還原 BERT 可能產生的子詞字首符號 (如 ##北 變成 北)
            t = t.replace(/^##/, "");

            // 3. 計算當前位置在 1D 陣列中的 Argmax 標籤
            const baseIndex = (b * seqLen * numClasses) + (i * numClasses);
            const scoreB = data[baseIndex];
            const scoreI = data[baseIndex + 1];
            const predTag = scoreB >= scoreI ? 'B' : 'I';

            // 4. 進行斷詞拼湊
            if (predTag === 'B' && word !== "") {
                res.append ? res.push(word) : res.push(word); // JS 使用 push
                word = t;
            } else {
                word += t;
            }
        }

        // 補上最後一個未完結的詞
        if (word) {
            res.push(word);
        }

        finalResult.push(res);
    }

    return finalResult;
}



// 核心推論邏輯
async function runInference(sentences) {
	let texts = sentences;
    const batchSize = texts.length;

    let allInputIds = [];
    let allTokenIds = [];
    let allMaskIds = [];

    for (let idx = 0; idx < batchSize; idx++) {
        const text = texts[idx].toLowerCase();  

        // 呼叫 Transformers.js Tokenizer
        const encoded = await tokenizer(text, { return_tensor: 'np' });
        const inputIdsArr = Array.from(encoded.input_ids.data);
        
        allInputIds.push(inputIdsArr);
        allTokenIds.push(new Array(inputIdsArr.length).fill(0));
        allMaskIds.push(new Array(inputIdsArr.length).fill(1));
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
        "attention_mask": new Tensor('int64', new BigInt64Array(allMaskIds.flat().map(BigInt)), [batchSize, maxSeqLen])
    };
    
    // 執行 ONNX 推論
    const outputs = await model(onnxInputs);

    let tokens = [];
    for (let idx = 0; idx < batchSize; idx++) {
    	let token = tokenizer.model.convert_ids_to_tokens(allInputIds[idx]);
    	tokens.push(token);
    }
    
    let result = decodeBIOSegmentation(tokens,outputs)

    return result;
}

