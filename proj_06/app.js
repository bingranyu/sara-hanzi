import {G2PWClient, WSClient, preprocessArticle} from "./module/tools.js"; 

// --- 核心應用程式控制器 (SPA Controller) ---
const app = {
    currentView: 'view-welcome',

    // 全域狀態管理
    state: {
        catalog: null,
        user: {
            interest_tags: [],
            current_level: 1
        },
        // 儲存目前正在閱讀的文章完整資料
        currentArticle: null, 
        // 儲存模型實例
        models: {
            g2pw: null,
            ws: null,
            isLoaded: false
        }
    },

    // 1. 初始化設定
    async init() {
        console.log("App Initialized");
        
        // 異步讀取目錄
        await this.loadCatalog();
        this.loadUserData();

        // 背景非同步初始化斷詞與注音模型，不卡住首頁載入
        this.initReadingModels();

        window.addEventListener('popstate', (event) => {
            if (event.state && event.state.view) {
                this._switchView(event.state.view);
            }
        });

        this.bindEvents();
    },

    // 異步初始化模型 (G2PW & Word Segmentation)
    async initReadingModels() {
        try {
            console.log("開始載入前端 AI 模型...");
            this.state.models.g2pw = new G2PWClient();
            await this.state.models.g2pw.initModel();

            this.state.models.ws = new WSClient();
            await this.state.models.ws.initModel();

            this.state.models.isLoaded = true;
            console.log("前端 AI 模型初始化成功！");
        } catch (error) {
            console.error("模型載入失敗，將啟動純文字備災呈現:", error);
        }
    },

    async loadCatalog() {
        try {
            const response = await fetch('catalog.json');
            this.state.catalog = await response.json();
        } catch (error) {
            console.error("無法載入 catalog.json:", error);
            this.state.catalog = { tags_master_list: [], articles: [] };
        }
    },

    loadUserData() {
        const localData = localStorage.getItem('little_tree_user_data');
        if (localData) {
            try { this.state.user = JSON.parse(localData); } catch (e) {}
        }
    },

    saveUserData() {
        localStorage.setItem('little_tree_user_data', JSON.stringify(this.state.user));
    },

    bindEvents() {
        const btnManageTags = document.getElementById('btn-manage-tags');
        if (btnManageTags) {
            btnManageTags.addEventListener('click', () => {
                this.renderTagPicker(true);
                this.navigate('view-tag-picker');
            });
        }
		
		
    },

    startReadingFlow() {
        if (!this.state.user.interest_tags || this.state.user.interest_tags.length < 3) {
            this.renderTagPicker(false);
            this.navigate('view-tag-picker');
        } else {
            this.renderBookshelf();
            this.navigate('view-bookshelf');
        }
    },

    renderTagPicker(isAppendedMode = false) {
        const container = document.getElementById('tag-list-container');
        const submitBtn = document.getElementById('btn-submit-tags');
        const titleEl = document.getElementById('tag-picker-title');
        const masterList = this.state.catalog.tags_master_list || [];
        
        if (isAppendedMode) {
            titleEl.innerText = "想增加什麼興趣呢？";
            submitBtn.innerText = "更新我的書架";
        } else {
            titleEl.innerText = "選 3 個你最喜歡的東東！";
            submitBtn.innerText = "選好了！打開魔法書架";
        }

        container.innerHTML = '';
        const selectedTags = new Set(this.state.user.interest_tags);

        const updateSubmitButtonState = () => {
            if (selectedTags.size >= 3) {
                submitBtn.removeAttribute('disabled');
                submitBtn.classList.remove('disabled');
            } else {
                submitBtn.setAttribute('disabled', 'true');
                submitBtn.classList.add('disabled');
                if (!isAppendedMode) {
                    submitBtn.innerText = `還需要再選 ${3 - selectedTags.size} 個喔！`;
                }
            }
        };

        masterList.forEach(tag => {
            const tagBtn = document.createElement('button');
            tagBtn.className = `tag-pick-item ${selectedTags.has(tag) ? 'selected' : ''}`;
            tagBtn.innerText = tag;
            
            tagBtn.addEventListener('click', () => {
                if (selectedTags.has(tag)) {
                    selectedTags.delete(tag);
                    tagBtn.classList.remove('selected');
                } else {
                    selectedTags.add(tag);
                    tagBtn.classList.add('selected');
                }
                updateSubmitButtonState();
            });
            container.appendChild(tagBtn);
        });

        submitBtn.onclick = () => {
            if (selectedTags.size >= 3) {
                this.state.user.interest_tags = Array.from(selectedTags);
                this.saveUserData();
                this.renderBookshelf();
                this.navigate('view-bookshelf');
            }
        };

        updateSubmitButtonState();
    },

    renderBookshelf() {
        const scrollContainer = document.getElementById('bookshelf-scroll-container');
        if (!scrollContainer) return;

        scrollContainer.innerHTML = '';
        const articles = this.state.catalog.articles || [];
        const userTags = this.state.user.interest_tags || [];

        const matchedArticles = articles.filter(article => {
            return article.tags.some(tag => userTags.includes(tag));
        });

        const displayArticles = matchedArticles.slice(0, 8);

        if (displayArticles.length === 0) {
            scrollContainer.innerHTML = `<p class="empty-hint">書架空空的，試著點左上角加點興趣吧！</p>`;
            return;
        }

        displayArticles.forEach(article => {
            const leafIcons = "🌿".repeat(article.level || 1);
            const card = document.createElement('div');
            card.className = 'book-card';
            
            // 核心變更：點擊時傳入文章 ID 進行非同步讀取
            card.onclick = () => app.loadAndOpenArticle(article.id);

            card.innerHTML = `
                <div class="book-cover" style="background: ${app._getRandomPastelColor()};">${article.cover_emoji}</div>
                <div class="book-info">
                    <span class="difficulty">${leafIcons}</span>
                    <h3>${article.title}</h3>
                    <div class="card-tags">
                        ${article.tags.map(t => `<span class="tag">${t}</span>`).join('')}
                    </div>
                </div>
            `;
            scrollContainer.appendChild(card);
        });
    },

    // 核心追加功能 1：根據書本 ID 抓取對應文章 JSON 並處理呈現（已優化為分段漸進呈現）
    async loadAndOpenArticle(articleId) {
        try {
            // 1. 顯示載入中提示
            document.getElementById('view-reader').innerHTML = `<div class="loading-box">🧚‍♀️ 魔法書載入中...</div>`;
            this.navigate('view-reader');

            // 2. 抓取文章 JSON
            const response = await fetch(`articles/${articleId}.json`);
            if (!response.ok) throw new Error("找不到文章檔案");
            const articleData = await response.json();
			console.log(articleData);
            
            this.state.currentArticle = articleData;

            // 3. 先行初始化閱讀器基礎外殼 (標題與基礎互動)
            let processedTitle = articleData.title;
            if (this.state.models.isLoaded) {
                processedTitle = await preprocessArticle(articleData.title, this.state.models.ws, this.state.models.g2pw);
            } else {
                processedTitle = this._fallbackProcess(articleData.title)[0]; 
            }

            // 初始化外殼（此時內文容器是空的，題目先隱藏或放著）
            this.renderReaderViewSkeleton(processedTitle, articleData.questions);

            // 4. 🌟 分段漸進式處理內文
            const pContainer = document.getElementById('article-paragraphs-container');
            // 假設 articleData.text 是一個陣列（各段落文字），若它是純文字字串，則用換行符號切分：
            const paragraphsText = Array.isArray(articleData.text) 
                ? articleData.text 
                : articleData.text.split('\n').filter(p => p.trim() !== '');

            const totalParagraphs = paragraphsText.length;

            for (let i = 0; i < totalParagraphs; i++) {
                const rawParagraph = paragraphsText[i];
                let processedParagraph = [];

                if (this.state.models.isLoaded) {
                    // 逐段送入模型，不卡住其他段落
                    processedParagraph = await preprocessArticle(rawParagraph, this.state.models.ws, this.state.models.g2pw);
					console.log(processedParagraph);
                } else {
                    processedParagraph = this._fallbackProcess(rawParagraph);
                }

                // 渲染單一建立的新段落
                this.appendParagraphToReader(processedParagraph, i);

                // 動態更新進度條（可選，增加趣味性）
                const progressPercent = Math.min(10 + Math.floor(((i + 1) / totalParagraphs) * 80), 90);
                const progressBar = document.getElementById('reader-progress');
                if (progressBar) progressBar.style.width = `${progressPercent}%`;
            }

            // 全部段落載入完成，進度條到 100%
            const progressBar = document.getElementById('reader-progress');
            if (progressBar) progressBar.style.width = `100%`;

        } catch (error) {
            console.error("載入文章失敗:", error);
            alert("故事書還在準備中，先換一本試試看吧！");
            this.navigate('view-bookshelf');
        }
    },

    // 拆分出來的方法：只渲染外殼
    renderReaderViewSkeleton(processedTitle, questions) {
        const readerView = document.getElementById('view-reader');
        
		readerView.innerHTML = `
            <header class="top-bar reader-bar">
                <button class="btn-icon" onclick="app.navigate('view-bookshelf')">🔙</button>
                <div class="progress-bar-container">
                    <div id="reader-progress" class="progress-bar" style="width: 10%;">🚀</div>
                </div>
                <button class="btn-primary small" onclick="app.startQuizFlow()">讀完了 🏁</button>
            </header>
            <main class="reader-theatre">
                <h1 class="reader-article-title">${this._generateRubyHTML(processedTitle)}</h1>
                <div class="text-content" id="article-paragraphs-container"></div>
                
                <div class="quiz-section" id="quiz-container" style="display: none;">
                    <div id="quiz-questions-list"></div>
                </div>
            </main>
        `;

        // 啟動點擊事件監聽 (利用事件代理，新長出來的段落也能直接點擊，不需重複初始化)
        this._initReaderInteractions();
    },

    // 拆分出來的方法：每處理完一段就追加一段到畫面上
    appendParagraphToReader(paragraphWords, index) {
        const pContainer = document.getElementById('article-paragraphs-container');
        if (!pContainer) return;

        const p = document.createElement('p');
        p.className = "reader-paragraph";
		p.setAttribute('data-p-index', index);
        p.innerHTML = this._generateRubyHTML(paragraphWords);
        
		// 確保段落內的每一個句子區塊，都有加上專屬的類別，方便尋寶搜尋
		p.querySelectorAll('.sentence-block').forEach(sNode => {
            sNode.classList.add('article-sentence');
        });
		
        // 問問爸媽按鈕
        const askBtn = document.createElement('button');
        askBtn.className = 'btn-ask-parents';
        askBtn.innerHTML = '⭐';
        askBtn.onclick = (e) => {
            e.stopPropagation(); 
            askBtn.classList.toggle('marked');
            console.log(`標記第 ${index + 1} 段送入家長專區`);
        };
        p.appendChild(askBtn);

        pContainer.appendChild(p);
    },

    // 全新獨立的閱讀互動控制邏輯
    _initReaderInteractions() {
        const readerView = document.getElementById('view-reader');
        if (!readerView) return;

        // 移除可能殘留的舊監聽器，確保不重複觸發
        if (this._readerClickHandler) {
            readerView.removeEventListener('click', this._readerClickHandler);
        }

        this._readerClickHandler = (e) => {
			console.log(e);
            // 尋找被點擊的句子區塊
            const sentenceEl = e.target.closest('.sentence-block');
            if (!sentenceEl) return;

            const isHighlighted = sentenceEl.classList.contains('show-scaffold');

            if (!isHighlighted) {
				console.log("沒反黃")
                // 【情境一：句子沒反黃】 -> 點擊任何地方，就只讓它反黃（此時不加任何注音）
                
                // 清除畫面上其他句子的反黃與注音
                readerView.querySelectorAll('.sentence-block').forEach(el => {
                    el.classList.remove('show-scaffold');
                    el.querySelectorAll('.word-item').forEach(w => w.classList.remove('show-bopomo'));
                });

                // 當前句子反黃
                sentenceEl.classList.add('show-scaffold');

                // 5秒後自動淡出防呆
                if (sentenceEl.scaffoldTimeout) clearTimeout(sentenceEl.scaffoldTimeout);
                sentenceEl.scaffoldTimeout = setTimeout(() => {
                    sentenceEl.querySelectorAll('.word-item').forEach(w => w.classList.remove('show-bopomo'));
                }, 3000);
				return
            } else {
				console.log("已經在反黃狀態")
                // 【情境二：句子已經在反黃狀態下】
                const wordEl = e.target.closest('.word-item');
                
                if (wordEl) {
                    // 如果點到的是「詞」-> 顯示/隱藏該詞的注音
                    e.stopPropagation();
                    wordEl.classList.toggle('show-bopomo');
                    
                    // 點擊詞彙時，延長句子的 5 秒計時器，避免看注音看到一半突然消失
                    if (sentenceEl.scaffoldTimeout) clearTimeout(sentenceEl.scaffoldTimeout);
                    sentenceEl.scaffoldTimeout = setTimeout(() => {
                        sentenceEl.querySelectorAll('.word-item').forEach(w => w.classList.remove('show-bopomo'));
                    }, 3000);
                } else {
                    // 如果點到的是句子內的空白 -> 直接關閉這句的反黃
                    sentenceEl.querySelectorAll('.word-item').forEach(w => w.classList.remove('show-bopomo'));
                    if (sentenceEl.scaffoldTimeout) clearTimeout(sentenceEl.scaffoldTimeout);
                }
            }
        };

        readerView.addEventListener('click', this._readerClickHandler);
    },
	
	_generateRubyHTML(wordArray) {
		if (!Array.isArray(wordArray)) return wordArray;
		
		// 1. 處理 3D/4D 段落陣列 (段落 -> 句子 -> 詞彙)
		if (wordArray.length > 0 && Array.isArray(wordArray[0]) && Array.isArray(wordArray[0][0])) {
			return wordArray.map(paragraph => {
				return this._generateRubyHTML(paragraph);
			}).join('');
		}

		// 2. 處理 2D 句子層級 (句子 -> 詞彙)
		if (wordArray.length > 0 && Array.isArray(wordArray[0])) {
			return wordArray.map(sentence => {
				const sentenceHTML = sentence.map(item => this._processSingleVocab(item)).join('');
				return `<span class="sentence-block">${sentenceHTML}</span>`;
			}).join('');
		}

		// 3. 🌟 升級 1D 陣列分支 (專門應對標題或單純詞彙陣列)
		// 確保 preprocessTitle 回傳的 1D 結構也能完整被過濾與解析
		if (wordArray.length > 0 && typeof wordArray[0] === 'object') {
			return wordArray.map(item => this._processSingleVocab(item)).join('');
		}

		// 4. 極端降級機制（純字串陣列）
		return wordArray.map(item => item.vocab || item).join('');
	},

	// 🌟 抽離出來的核心單一詞彙處理邏輯，標題與內文共用
	_processSingleVocab(item) {
		const vocab = item.vocab || '';
		const bopomos = item.bopomo || [];
		
		// 1) 只要整個詞彙不含中文字，直接當作純標點符號輸出
		if (!/[\u4E00-\u9FFF]/.test(vocab)) {
			return `<span class="word punctuation">${vocab}</span>`;
		}

		// 中文或混雜標點的詞彙：包上 .word-item，並逐字配對
		let rubyInner = '';
		const chars = Array.from(vocab);
		
		chars.forEach((char, idx) => {
			const bp = bopomos[idx] || '';
			
			// 合法注音與聲調的正則表達式
			const isValidBopomo = /^[\u3105-\u312F1-5]+$/.test(bp);

			// 終極防禦條件：非中文字、注音為空、或注音不合法時，不生成 <rt>
			if (!/[\u4E00-\u9FFF]/.test(char) || bp === '' || !isValidBopomo) {
				rubyInner += char; 
			} else {
				// 正常中文與注音處理
				const displayBp = bp.replace('1', '').replace('2', 'ˊ').replace('3', 'ˇ').replace('4', 'ˋ').replace('5', '');
				const tomdot = bp.match(/[5]/) ? `<span class="ruby-tmdot">˙</span>` : '';
				
				rubyInner += `<ruby>${char}<rt>${tomdot}${displayBp}</rt></ruby>`;
			}
		});

		return `<span class="word word-item">${rubyInner}</span>`;
	},

    // 綁定注音 5 秒淡出與鷹架點擊機制
    bindRubyInteraction() {
        const words = document.querySelectorAll('.text-content .word ruby');
        words.forEach(rubyEl => {
            let clickCount = 0;
            
            rubyEl.addEventListener('click', (e) => {
                e.stopPropagation();
                clickCount++;
                
                // 點擊即為該詞加上顯示注音的 class
                //rubyEl.classList.add('show-scaffold');

                // 核心 PRD 機制：若同一個詞連續點擊 3 次以上，判定為魔王詞，保持顯示不淡出
                if (clickCount >= 3) {
                    rubyEl.classList.add('boss-word');
                    console.log("觸發魔王詞機制，保持顯示。");
                    return;
                }

                // 溫和鷹架：5秒後自動淡出
                setTimeout(() => {
                    if (!rubyEl.classList.contains('boss-word')) {
                        rubyEl.classList.remove('show-scaffold');
                    }
                }, 5000);
            });
        });
    },

    // 降級備災模擬轉換器（在未連網或模型尚未加載完成時，防畫面崩潰）
    _fallbackProcess(text) {
        // 簡單依標點符號切斷，並回傳格式相容的 Mock 物件
        return [[{ "vocab": text, "bopomo": [] }]];
    },

    _getRandomPastelColor() {
        const colors = ['#FFD1D1', '#D1E8FF', '#E1FFD1', '#FFF3D1', '#E8D1FF'];
        return colors[Math.floor(Math.random() * colors.length)];
    },

    navigate(targetViewId) {
        if (this.currentView === targetViewId) return;
        this._switchView(targetViewId);
        window.history.pushState({ view: targetViewId }, '', `#${targetViewId}`);
        this.currentView = targetViewId;
    },

    _switchView(targetViewId) {
        const views = document.querySelectorAll('.view');
        views.forEach(view => {
            if (view.id === targetViewId) {
                view.classList.add('active');
            } else {
                view.classList.remove('active');
            }
        });
    },
	
// ==========================================================================
    // 🌟 全新追加：讀後挑戰與溫和尋寶狀態機模組
    // ==========================================================================
    
    // 挑戰模組的獨立狀態
    quizState: {
        currentIndex: 0,    // 目前進行到第幾題
        activeClueText: "", // 當前答錯、正在尋找的關鍵句
        wrongAttempts: 0    // 當前題目的答錯次數
    },

    // 1. 啟動挑戰入口 (當孩子點擊「讀完了」時觸發)
    startQuizFlow() {
        if (!this.state.currentArticle || !this.state.currentArticle.quizzes) {
            alert("這篇文章目前沒有安排小挑戰喔！");
            this.navigate('view-bookshelf');
            return;
        }
        this.quizState.currentIndex = 0;
        this.quizState.wrongAttempts = 0;
        this.quizState.activeClueText = "";
        
        // 切換到我們在 index.html 新增的 view-quiz 挑戰頁面
        this.navigate('view-quiz');
        this.renderCurrentQuiz();
    },

    // 2. 渲染當前題目與選項 (橫排、指尖友善版)
    renderCurrentQuiz() {
        const quizzes = this.state.currentArticle.quizzes;
        const currentQuiz = quizzes[this.quizState.currentIndex];
        
        // 更新進度文字
        document.getElementById('quiz-progress').innerText = `第 ${this.quizState.currentIndex + 1} / ${quizzes.length} 題`;
        
        // 填入題目
        document.getElementById('quiz-question-text').innerText = currentQuiz.question;
        
        // 隱藏上一次的錯誤反饋框
        document.getElementById('quiz-feedback-box').classList.add('hidden');
        
        // 渲染選項
        const container = document.getElementById('quiz-options-container');
        container.innerHTML = '';
        
        currentQuiz.options.forEach((optionText, index) => {
            const btn = document.createElement('button');
            btn.className = 'quiz-option-btn';
            btn.innerText = optionText;
            btn.onclick = () => this.handleAnswerSubmit(index, btn);
            container.appendChild(btn);
        });
    },

    // 3. 檢查答案 (無挫折導引)
    handleAnswerSubmit(selectedIndex, clickedButton) {
        const quizzes = this.state.currentArticle.quizzes;
        const currentQuiz = quizzes[this.quizState.currentIndex];
        
        if (selectedIndex === currentQuiz.correct_index) {
            // 答對了！閃爍綠色回饋
            clickedButton.classList.add('correct');
            setTimeout(() => {
                this.quizState.currentIndex++;
                if (this.quizState.currentIndex < quizzes.length) {
                    this.renderCurrentQuiz();
                } else {
                    // 答完最後一題，顯示恭喜與下一篇推薦
                    this.showCelebrationAndRecommendation();
                }
            }, 800);
        } else {
            // 答錯了：不顯示大叉叉，將被點選的錯誤選項變灰變淡
            clickedButton.disabled = true;
            clickedButton.classList.add('wrong');
            
            this.quizState.wrongAttempts++;
            // 完美對齊新版 AI 規格：直接拿取複製貼上的 hint_text
            this.quizState.activeClueText = currentQuiz.hint_text || ""; 
            
            // 溫和浮現「搭魔法毯回去找找看」的按鈕
            document.getElementById('quiz-feedback-box').classList.remove('hidden');
        }
    },

// 4. 【核心尋寶機制】點擊「回去找線索」
    goToFindClue() {
        // 先切換回閱讀器視圖，讓孩子看文章
        this._switchView('view-reader'); 

        // 效果 1：把已經反黃或點擊過的段落與句子全部取消反黃，清空畫面干擾
        document.querySelectorAll('.sentence-block').forEach(el => {
            el.classList.remove('show-scaffold', 'clue-highlight-spotlight');
        });
        
        // 同時移除畫面上先前可能殘留的舊寶藏圖示，避免重複長出寶藏
        document.querySelectorAll('.quiz-treasure-icon').forEach(el => el.remove());
        
        // 抓取畫面上所有的句子節點
        const allSentences = document.querySelectorAll('.article-sentence');
        let targetSentenceNode = null;
        
        if (this.quizState.activeClueText) {
            for (let node of allSentences) {
                // 🌟 核心修正：複製節點並拔除其中的 <rt> 標籤，還原出「沒有注音的純國字文字」
                const cloneNode = node.cloneNode(true);
                cloneNode.querySelectorAll('rt').forEach(rt => rt.remove());
                const pureChineseText = cloneNode.textContent; // 這時就會是純國字了！

                // 拿純國字跟 AI 的題庫線索做比對
                if (pureChineseText.includes(this.quizState.activeClueText)) {
                    targetSentenceNode = node;
                    break;
                }
            }
        }
        
        if (targetSentenceNode) {
            // 效果 2：把 hint_text 對到的那一句話加上聚光燈發光反黃
            targetSentenceNode.classList.add('clue-highlight-spotlight');
            
            // 效果 2：在句子旁邊（最前端）浮現一個寶藏小 icon
            const treasureIcon = document.createElement('span');
            treasureIcon.className = 'quiz-treasure-icon';
            treasureIcon.innerText = '💎'; // 您也可以換成 🎁、🏴‍☠️ 或 👑
            
            // 使用 prepend 塞入句首，孩子橫向滾動畫面時會第一眼看到
            targetSentenceNode.prepend(treasureIcon);
            
            // 直式排版專屬橫向平滑捲動：自動幫你把發光與帶有寶藏的段落滾動到視窗中央
            targetSentenceNode.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
        
        // 在右下角浮現「我找到了！回挑戰 👑」的懸浮按鈕
        document.getElementById('btn-return-to-quiz').classList.remove('hidden');
    },

    // 5. 看完提示，一鍵重返題目
    returnToQuizFromClue() {
        // 隱藏懸浮按鈕
        document.getElementById('btn-return-to-quiz').classList.add('hidden');
        
        // 清除尋寶發光類別，並拔除剛才動態生成的寶藏小 icon
        document.querySelectorAll('.clue-highlight-spotlight').forEach(el => el.classList.remove('clue-highlight-spotlight'));
        document.querySelectorAll('.quiz-treasure-icon').forEach(el => el.remove());
        
        // 切回挑戰蓋屏，繼續剛才沒寫完的那一題
        this._switchView('view-quiz');
    },

    // 6. 暫離挑戰視圖
    closeQuizView() {
        document.getElementById('btn-return-to-quiz').classList.add('hidden');
        this.navigate('view-reader');
    },

    // 7. 通關全對歡慶，並撈取 catalog.json 實現智慧續讀推薦
    showCelebrationAndRecommendation() {
        const overlay = document.getElementById('quiz-celebration-overlay');
        overlay.classList.remove('hidden');
        
        const recBox = document.getElementById('next-recommendation-box');
        recBox.innerHTML = '';
        
        // 檢查是否有書籍目錄可以撈取推薦
        if (this.state.catalog && this.state.catalog.articles) {
            const currentId = this.state.currentArticle.article_id;
            // 排除當前讀的這篇，挑選下一篇（若無則拿第一篇）
            const nextArticle = this.state.catalog.articles.find(a => a.id !== currentId) || this.state.catalog.articles[0];
            
            if (nextArticle) {
                recBox.innerHTML = `
                    <p>下一篇推薦你讀這個魔法寶箱：</p>
                    <button class="btn-recommend-card" onclick="app.loadAndRecommendNext('${nextArticle.id}')">
                        <span class="rec-emoji">${nextArticle.cover_emoji || '📚'}</span>
                        <span class="rec-title">${nextArticle.title}</span>
                    </button>
                `;
            }
        }
    },

    // 8. 點擊推薦卡片，一鍵無縫載入新書
    async loadAndRecommendNext(articleId) {
        // 隱藏全螢幕通關特效
        document.getElementById('quiz-celebration-overlay').classList.add('hidden');
        
        // 直接調用您原有的全套 AI 載入與分段渲染流
        await this.loadAndOpenArticle(articleId);
    }
	
};




window.app = app;
document.addEventListener('DOMContentLoaded', () => {
    app.init();
    window.history.replaceState({ view: 'view-welcome' }, '', `#view-welcome`);
});