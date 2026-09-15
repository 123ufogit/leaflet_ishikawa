/**
 * themeHandler.js - UIカラーリング・テーマ切り替え管理モジュール
 * GIS Browser - Leaflet WebGIS
 * 
 * 4つのカラーリングテーマ（外見レイアウトは変えず、カラーパレットと象徴アイコンセットを切り替え）:
 * 1. default: Cyber Dark（ネオンサイバー・ディープスペース・ダークグラスモーフィズム）
 * 2. forest: Forest Field（森林・フィールドワーク・自然調和エメラルド）
 * 3. sunlight: High-Visibility Outdoor（屋外の晴天下でも見やすい白基調・高彩度・ハイコントラスト）
 * 4. universal: Universal Design（CUDO推奨カラーユニバーサルデザイン準拠・色覚多様性対応）
 */
(function (GIS) {
  'use strict';

  const STORAGE_KEY = 'gis_browser_theme';

  const THEMES = [
    {
      id: 'default',
      name: 'Cyber Dark',
      subtitle: 'ネオンサイバー（標準）',
      description: 'ディープネイビーとシアン・パープルのサイバーグラスモーフィズム',
      icons: {
        logo: '🗺️',
        dropZone: '📂',
        accordionTitle: '🗂️ レイヤーセット',
        layerTitle: '📚 レイヤー',
        clearAll: '🗑 全削除',
        drawing: '✏️',
        export: '💾',
        settings: '⚙️',
        help: '❓',
        recent: '🕒 最近読み込んだレイヤ'
      }
    },
    {
      id: 'forest',
      name: 'Forest Field',
      subtitle: '森林・フィールドワーク調',
      description: '深緑とライム・アースカラーの自然調和デザイン',
      icons: {
        logo: '🧭',
        dropZone: '🌲',
        accordionTitle: '📑 レイヤーセット',
        layerTitle: '🌿 レイヤー',
        clearAll: '🧹 全削除',
        drawing: '📐',
        export: '📦',
        settings: '🛠️',
        help: '💡',
        recent: '⏳ 最近読み込んだレイヤ'
      }
    },
    {
      id: 'sunlight',
      name: 'High-Visibility Outdoor',
      subtitle: '屋外・晴天下ビビッド調',
      description: '強い直射日光下でも視認しやすい高コントラスト・白基調カラフルデザイン',
      icons: {
        logo: '☀️',
        dropZone: '📥',
        accordionTitle: '📂 レイヤーセット',
        layerTitle: '🗃️ レイヤー',
        clearAll: '❌ 全削除',
        drawing: '🖊️',
        export: '📤',
        settings: '🔧',
        help: '❔',
        recent: '⏱️ 最近読み込んだレイヤ'
      }
    },
    {
      id: 'universal',
      name: 'Universal Design',
      subtitle: 'カラーユニバーサルデザイン（CUD）準拠',
      description: '多様な色覚（P型・D型・T型）に配慮したUDオレンジ・スカイブルー配色',
      icons: {
        logo: '🌐',
        dropZone: '📁',
        accordionTitle: '📋 レイヤーセット',
        layerTitle: '📊 レイヤー',
        clearAll: '🗑️ 全削除',
        drawing: '📏',
        export: '💾',
        settings: '⚙️',
        help: 'ℹ️',
        recent: '🕒 最近読み込んだレイヤ'
      }
    }
  ];

  GIS.ThemeHandler = {
    currentThemeIndex: 0,

    init() {
      // 保存されたテーマの復元
      const savedThemeId = localStorage.getItem(STORAGE_KEY);
      if (savedThemeId) {
        const foundIdx = THEMES.findIndex(t => t.id === savedThemeId);
        if (foundIdx !== -1) {
          this.currentThemeIndex = foundIdx;
        }
      }

      this.applyTheme(this.currentThemeIndex, false);
      this._bindLongPress();
    },

    /**
     * 次のテーマへ切り替え（4回で元に戻る）
     */
    nextTheme() {
      this.currentThemeIndex = (this.currentThemeIndex + 1) % THEMES.length;
      const theme = THEMES[this.currentThemeIndex];
      localStorage.setItem(STORAGE_KEY, theme.id);
      this.applyTheme(this.currentThemeIndex, true);
    },

    /**
     * 指定インデックスのテーマをDOMへ適用
     * @param {number} index
     * @param {boolean} showToastNotify
     */
    applyTheme(index, showToastNotify = false) {
      const theme = THEMES[index] || THEMES[0];
      const root = document.documentElement;

      // HTMLタグに data-theme 属性をセット
      if (theme.id === 'default') {
        root.removeAttribute('data-theme');
      } else {
        root.setAttribute('data-theme', theme.id);
      }

      // アイコンの差し替え（パネルやアイコンの配置・構造は一切変えず文字・グリフのみ更新）
      this._updateThemeIcons(theme.icons);

      // トースト通知（手動切り替え時のみ）
      if (showToastNotify && GIS.UI && GIS.UI.showToast) {
        GIS.UI.showToast(`🎨 テーマ切替: ${theme.name}（${theme.subtitle}）`, 'success');
      }
    },

    /**
     * DOM要素のアイコンをテーマ定義に合わせて更新
     * @param {object} icons
     */
    _updateThemeIcons(icons) {
      // 1. パネルロゴ
      const logoEl = document.querySelector('.panel-logo');
      if (logoEl) logoEl.textContent = icons.logo;

      // 2. ドロップゾーンアイコン
      const dropZoneIcon = document.querySelector('.drop-zone-icon');
      if (dropZoneIcon) dropZoneIcon.textContent = icons.dropZone;

      // 3. アコーディオンタイトル
      const accTitle = document.querySelector('.accordion-title');
      if (accTitle) accTitle.textContent = icons.accordionTitle;

      // 4. レイヤーリストタイトル
      const layerTitle = document.querySelector('.layer-list-title');
      if (layerTitle) layerTitle.textContent = icons.layerTitle;

      // 5. 全削除ボタン
      const clearAllBtn = document.getElementById('clear-all-btn');
      if (clearAllBtn) clearAllBtn.textContent = icons.clearAll;

      // 6. 作図ボタンアイコン
      const drawingIcon = document.querySelector('.drawing-btn-icon');
      if (drawingIcon) drawingIcon.textContent = icons.drawing;

      // 7. エクスポートボタンアイコン
      const exportIcon = document.querySelector('.unified-export-icon');
      if (exportIcon) exportIcon.textContent = icons.export;

      // 8. 設定アイコンボタン
      const settingsBtn = document.getElementById('btn-open-settings');
      if (settingsBtn) settingsBtn.textContent = icons.settings;

      // 9. ヘルプボタン
      const helpBtn = document.getElementById('btn-help');
      if (helpBtn) helpBtn.textContent = icons.help;

      // 10. 最近読み込んだレイヤボタン
      const recentBtn = document.getElementById('btn-recent-layers');
      if (recentBtn) recentBtn.textContent = icons.recent;
    },

    /**
     * 「GIS Browser」左側のロゴ（.panel-logo）の2秒長押しイベントをバインド
     */
    _bindLongPress() {
      const logoEl = document.querySelector('.panel-logo');
      if (!logoEl) return;

      let timer = null;
      let startX = 0;
      let startY = 0;
      let isLongPressed = false;
      const DURATION = 2000; // 2秒以上

      const cancelPress = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        logoEl.classList.remove('theme-switching-pulse');
      };

      const startPress = (clientX, clientY) => {
        isLongPressed = false;
        startX = clientX;
        startY = clientY;

        timer = setTimeout(() => {
          isLongPressed = true;
          timer = null;

          // 振動フィードバック
          if (navigator.vibrate) {
            try { navigator.vibrate(60); } catch (_) {}
          }

          // アニメーション効果
          logoEl.classList.add('theme-switching-pulse');
          setTimeout(() => {
            logoEl.classList.remove('theme-switching-pulse');
          }, 500);

          // テーマ切り替え
          this.nextTheme();
        }, DURATION);
      };

      // マウスイベント
      logoEl.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return; // 左クリックのみ
        e.stopPropagation(); // ドラッグハンドルへの伝播を抑止し確実な検出を行う
        startPress(e.clientX, e.clientY);
      });

      logoEl.addEventListener('mousemove', (e) => {
        if (!timer) return;
        if (Math.abs(e.clientX - startX) > 8 || Math.abs(e.clientY - startY) > 8) {
          cancelPress();
        }
      });

      logoEl.addEventListener('mouseup', cancelPress);
      logoEl.addEventListener('mouseleave', cancelPress);

      // タッチイベント
      logoEl.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) {
          cancelPress();
          return;
        }
        e.stopPropagation();
        const t = e.touches[0];
        startPress(t.clientX, t.clientY);
      }, { passive: false });

      logoEl.addEventListener('touchmove', (e) => {
        if (!timer || e.touches.length !== 1) {
          cancelPress();
          return;
        }
        const t = e.touches[0];
        if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) {
          cancelPress();
        }
      }, { passive: true });

      logoEl.addEventListener('touchend', cancelPress);
      logoEl.addEventListener('touchcancel', cancelPress);
    }
  };

  // DOMロード時に初期化
  document.addEventListener('DOMContentLoaded', () => {
    GIS.ThemeHandler.init();
  });

})(window.GIS = window.GIS || {});
