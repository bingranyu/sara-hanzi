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

function decodeBIOSegmentation(allTokens, outputData, originalTexts) {
    const { dims, data } = outputData.logits;
    const [batchSize, seqLen, numClasses] = dims;
    
    const finalResult = [];

    // 依序處理每一筆 Batch 資料
    for (let b = 0; b < batchSize; b++) {
        const tokens = allTokens[b]; // 取得該句子的所有 Tokens
        const originalText = originalTexts[b]; // 取得未經過 toLowerCase 的原始字串
        const res = [];
        
        let origIdx = 0; // 用來追蹤原始字串位置的指標
        let currentWord = "";

        // 遍歷該句子的每個序列位置
        const currentSeqLen = Math.min(seqLen, tokens.length);
        for (let i = 0; i < currentSeqLen; i++) {
            let t = tokens[i];

            // 跳過特殊符號
            if (['[CLS]', '[SEP]', '[PAD]'].includes(t)) {
                continue;
            }

            // 還原子詞字首符號
            t = t.replace(/^##/, "");

            // 計算當前位置的預測標籤 (B 或 I)
            const baseIndex = (b * seqLen * numClasses) + (i * numClasses);
            const scoreB = data[baseIndex];
            const scoreI = data[baseIndex + 1];
            const predTag = scoreB >= scoreI ? 'B' : 'I';

            // 根據 Token 的長度，從原始字串中「依序」取出對應長度的字元（包含原本的大寫、空格）
            let matchedStr = "";
            let tIdx = 0;
            
            // Tokenizer 有時會把空格變成特殊的 ' ' 或直接吃掉
            // 我們必須把原始字串中對應的字元抓出來
            while (tIdx < t.length && origIdx < originalText.length) {
                const origChar = originalText[origIdx];
                
                // 如果 Token 當前不是空格，但原始文字是空格，代表 Tokenizer 忽略了這個空格
                // 我們要把這個空格吞進來，算在當前詞彙裡
                if (t[tIdx] !== ' ' && (origChar === ' ' || origChar === '\xa0')) {
                    matchedStr += origChar;
                    origIdx++;
                    continue; 
                }
                
                matchedStr += origChar;
                origIdx++;
                tIdx++;
            }

            // 進行斷詞拼湊
            if (predTag === 'B' && currentWord !== "") {
                res.push(currentWord);
                currentWord = matchedStr;
            } else {
                currentWord += matchedStr;
            }
        }

        // 補上最後一個未完結的詞，並順便把原始字串後面可能剩餘的空格或符號補上
        if (origIdx < originalText.length) {
            currentWord += originalText.slice(origIdx);
        }

        if (currentWord) {
            res.push(currentWord);
        }

        finalResult.push(res);
    }

    return finalResult;
}



// 核心推論邏輯
async function runInference(sentences) {
    let texts = sentences; // 保留原始未變更大小寫的陣列
    const batchSize = texts.length;

    let allInputIds = [];
    let allTokenIds = [];
    let allMaskIds = [];

    for (let idx = 0; idx < batchSize; idx++) {
        // 推論時用小寫餵給 Tokenizer
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
    
    // 傳入第三個參數 texts (原始字串陣列) 進行解碼
    let result = decodeBIOSegmentation(tokens, outputs, texts);

    return result;
}

