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
                <button class="btn-primary small" onclick="app.navigate('view-bookshelf')">讀完了</button>
            </header>
            <main class="reader-theatre">
                <h1 class="reader-article-title">${this._generateRubyHTML(processedTitle)}</h1>
                <div class="text-content" id="article-paragraphs-container"></div>
                
                <div class="quiz-section" id="quiz-container">
                    <h3 class="quiz-section-title">✨ 讀後小挑戰 ✨</h3>
                    <div id="quiz-questions-list"></div>
                </div>
            </main>
        `;

        // 渲染題目
        const quizList = document.getElementById('quiz-questions-list');
        if (questions && questions.length > 0) {
            questions.forEach((q, qIndex) => {
                const qBox = document.createElement('div');
                qBox.className = 'quiz-item-box';
                qBox.innerHTML = `<p class="quiz-question-text">${qIndex + 1}. ${q.question}</p>`;
                
                const optionsContainer = document.createElement('div');
                optionsContainer.className = 'quiz-options-container';

                q.options.forEach(opt => {
                    const optBtn = document.createElement('button');
                    optBtn.className = 'quiz-opt-btn';
                    optBtn.innerHTML = `<span class="opt-emoji">${opt.emoji}</span> <span class="opt-text">${opt.text}</span>`;
                    optBtn.onclick = () => {
                        if (opt.is_correct) { optBtn.classList.add('correct'); } 
                        else { optBtn.classList.add('wrong'); optBtn.setAttribute('disabled', 'true'); }
                    };
                    optionsContainer.appendChild(optBtn);
                });
                qBox.appendChild(optionsContainer);
                quizList.appendChild(qBox);
            });
        } else {
            document.getElementById('quiz-container').style.display = 'none';
        }

        // 啟動點擊事件監聽 (利用事件代理，新長出來的段落也能直接點擊，不需重複初始化)
        this._initReaderInteractions();
    },

    // 拆分出來的方法：每處理完一段就追加一段到畫面上
    appendParagraphToReader(paragraphWords, index) {
        const pContainer = document.getElementById('article-paragraphs-container');
        if (!pContainer) return;

        const p = document.createElement('p');
        p.className = "reader-paragraph";
        p.innerHTML = this._generateRubyHTML(paragraphWords);
        
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
    }
};
window.app = app;
document.addEventListener('DOMContentLoaded', () => {
    app.init();
    window.history.replaceState({ view: 'view-welcome' }, '', `#view-welcome`);
});