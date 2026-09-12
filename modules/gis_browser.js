/**
 * gis_browser.js - メインアプリケーション初期化・モジュール統合
 * GIS Browser - Leaflet WebGIS
 * GitHub: https://github.com/your-repo/gis-browser
 */
(function () {
  'use strict';

  // ======================================================
  // アプリケーション初期化
  // ======================================================
  document.addEventListener('DOMContentLoaded', () => {
    initMap();
    initStatusBar();
    initControls();
    GIS.FloatingPanel.init();
    if (GIS.LayerHistoryHandler) GIS.LayerHistoryHandler.init();
    if (GIS.OfflineMapHandler) GIS.OfflineMapHandler.init(GIS.AppState.map);
    if (GIS.MobileGeolocationHandler) GIS.MobileGeolocationHandler.init(GIS.AppState.map);
  });

  /**
   * Leafletマップを初期化する
   */
  function initMap() {
    const map = L.map('map', {
      center: [36.432416, 136.639853], // 石川県農林総合研究センター林業試験場
      zoom: 15,
      zoomControl: true,
      attributionControl: true
    });

    // ベースマップ用専用ペインの作成（最背面: z-index 100）
    // これにより、ベースマップを切り替えても他の全レイヤー（タイル・ベクター・画像）の手前に出ない
    const basemapPane = map.createPane('basemapPane');
    basemapPane.style.zIndex = 100;

    // ベースマップレイヤー定義
    const basemaps = {
      standard: L.tileLayer(
        'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
        {
          attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
          maxZoom: 18,
          crossOrigin: true,
          pane: 'basemapPane'
        }
      ),
      ortho: L.tileLayer(
        'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
        {
          attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
          maxZoom: 18,
          crossOrigin: true,
          pane: 'basemapPane'
        }
      ),
      osm: L.tileLayer(
        'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        {
          attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
          maxZoom: 19,
          pane: 'basemapPane'
        }
      )
    };

    basemaps.standard.addTo(map);
    if (typeof basemaps.standard.bringToBack === 'function') {
      basemaps.standard.bringToBack();
    }
    GIS.AppState.map = map;
    GIS.AppState._basemaps = basemaps;
    GIS.AppState._currentBasemap = 'standard';
  }

  /**
   * マウス座標ステータスバーを初期化する
   */
  function initStatusBar() {
    const map   = GIS.AppState.map;
    const elCoords = document.getElementById('status-coords');
    const elZoom   = document.getElementById('status-zoom');
    if (!elCoords || !elZoom) return;

    // 初期表示
    const updateZoom = () => {
      elZoom.textContent = `Zoom ${map.getZoom()}`;
    };
    updateZoom();

    // マウスムーブで座標更新
    map.on('mousemove', (e) => {
      const { lat, lng } = e.latlng;
      elCoords.textContent =
        `${lat >= 0 ? '' : ''}${lat.toFixed(6)}°, ` +
        `${lng >= 0 ? '' : ''}${lng.toFixed(6)}°`;
    });

    // 地図外に出たらリセット
    map.on('mouseout', () => {
      elCoords.textContent = '— , —';
    });

    // ズーム変更時
    map.on('zoomend', updateZoom);
  }

  /**
   * ツールバー・ボタン等のUI制御を初期化する
   */
  function initControls() {
    // ベースマップ切り替えボタン
    document.querySelectorAll('[data-basemap]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.basemap;
        const map = GIS.AppState.map;
        const basemaps = GIS.AppState._basemaps;
        const current = GIS.AppState._currentBasemap;

        if (key === current) return;
        map.removeLayer(basemaps[current]);
        basemaps[key].addTo(map);
        if (typeof basemaps[key].bringToBack === 'function') {
          basemaps[key].bringToBack();
        }
        GIS.AppState._currentBasemap = key;

        // ベースマップ切り替え後も、すべての有効なレイヤーが手前に維持されるよう再配置
        if (GIS.AppState && GIS.AppState.layers) {
          GIS.AppState.layers.forEach(entry => {
            if (entry.visible && entry.layer && map.hasLayer(entry.layer)) {
              if (typeof entry.layer.bringToFront === 'function') {
                try { entry.layer.bringToFront(); } catch (_) {}
              }
            }
          });
        }

        document.querySelectorAll('[data-basemap]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // 統合エクスポートボタン
    const unifiedExportBtn = document.getElementById('btn-unified-export');
    if (unifiedExportBtn) {
      unifiedExportBtn.addEventListener('click', () => GIS.ExportHandler.executeUnifiedExport());
    }

    // 設定モーダルの開閉
    const settingsBtn = document.getElementById('btn-open-settings');
    const settingsModal = document.getElementById('settings-modal');
    const closeSettingsBtn = document.getElementById('btn-close-settings');
    const saveSettingsBtn = document.getElementById('btn-save-settings');

    const openSettings = () => {
      if (settingsModal) {
        settingsModal.classList.remove('hidden');
        if (GIS.ExportHandler && GIS.ExportHandler.updateUIBadge) {
          GIS.ExportHandler.updateUIBadge();
        }
        if (GIS.OfflineMapHandler && GIS.OfflineMapHandler.updateCacheStatsUI) {
          GIS.OfflineMapHandler.updateCacheStatsUI();
        }
      }
    };

    const closeSettings = () => {
      if (settingsModal) settingsModal.classList.add('hidden');
    };

    if (settingsBtn) settingsBtn.addEventListener('click', openSettings);
    if (closeSettingsBtn) closeSettingsBtn.addEventListener('click', closeSettings);
    if (saveSettingsBtn) saveSettingsBtn.addEventListener('click', closeSettings);
    if (settingsModal) {
      settingsModal.addEventListener('click', (e) => {
        if (e.target === settingsModal) closeSettings();
      });
    }

    // エクスポートハンドラーの初期化（localStorageから設定復元）
    if (GIS.ExportHandler && GIS.ExportHandler.init) {
      GIS.ExportHandler.init();
    }

    // 画像モーダルを閉じる（Pannellumビューアも破棄）
    document.getElementById('image-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget || e.target.id === 'modal-close') {
        document.getElementById('image-modal').classList.add('hidden');
        document.getElementById('image-modal-content').innerHTML = '';
        // Pannellumビューアをクリーンアップ
        if (GIS.UI._modalViewer) {
          try { GIS.UI._modalViewer.destroy(); } catch (_) {}
          GIS.UI._modalViewer = null;
        }
      }
    });

    // モーダル内360°回転トグルボタン
    document.getElementById('modal-rotate-btn').addEventListener('click', () => {
      GIS.UI.toggleModalRotation();
    });

    // ポップアップ内の画像クリックをイベント委譲で処理する
    document.addEventListener('click', (e) => {
      const thumb = e.target.closest('.image-popup-thumb[data-src]');
      if (!thumb) return;
      const alt   = thumb.dataset.alt  || '';
      const is360 = thumb.dataset.is360 === 'true';

      // 360°画像はAppStateからフル解像度URLを取得する
      // （サムネイルではPannellumの全天球表示が正しく動かないため）
      let src = thumb.dataset.src;
      if (is360 && thumb.dataset.pinId) {
        const pin = GIS.AppState.getPinById(thumb.dataset.pinId);
        if (pin && pin.dataUrl) src = pin.dataUrl;
      }

      GIS.UI.openImageModal(src, alt, is360);
    });

    // エクスポート形式モーダルを閉じる（キャンセル）
    document.getElementById('export-format-cancel').addEventListener('click', () => {
      document.getElementById('export-format-modal').classList.add('hidden');
    });

    // ❓ ヘルプモーダルを開く
    document.getElementById('btn-help').addEventListener('click', () => {
      document.getElementById('help-modal').classList.remove('hidden');
    });
    // ヘルプモーダルを閉じる
    document.getElementById('help-modal-close').addEventListener('click', () => {
      document.getElementById('help-modal').classList.add('hidden');
    });
    document.getElementById('help-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        document.getElementById('help-modal').classList.add('hidden');
      }
    });

    // キーボードショートカット
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.getElementById('image-modal').classList.add('hidden');
        document.getElementById('export-format-modal').classList.add('hidden');
        document.getElementById('help-modal').classList.add('hidden');
        if (GIS.AppState.locationMode) {
          document.getElementById('location-mode-cancel').click();
        }
      }
    });

    // 縮尺コントロール
    L.control.scale({ imperial: false, position: 'bottomright' }).addTo(GIS.AppState.map);
  }

})();
