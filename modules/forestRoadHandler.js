/**
 * forestRoadHandler.js - 県営林・林道データの読み込みとLeaflet表示管理
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  /** 最小表示ズームレベル（林道） */
  const MIN_ZOOM_LEVEL = 14;

  /** HTML特殊文字のエスケープ */
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  GIS.ForestRoadHandler = {
    isLoaded: false,
    keneirinLayerId: null,
    roadLayerId: null,
    keneirinGroupLayer: null,
    roadGroupLayer: null,
    rawKeneirinGeoJSON: null,
    rawRoadGeoJSON: null,
    _zoomListenerAttached: false,

    init: function () {
      this._bindButton();
      this._listenAppStateEvents();
    },

    /**
     * UIボタンイベントのバインド
     */
    _bindButton: function () {
      const btn = document.getElementById('btn-load-forest-roads');
      if (btn) {
        btn.addEventListener('click', () => {
          this.toggleForestRoads();
        });
      }
    },

    /**
     * AppStateイベントのリッスン（レイヤー削除・全削除時のボタン状態リセット、トグル時のズーム制御）
     */
    _listenAppStateEvents: function () {
      if (!GIS.AppState) return;

      GIS.AppState.on('layerRemoved', ({ id }) => {
        if (id === this.keneirinLayerId) {
          this.keneirinLayerId = null;
          this.keneirinGroupLayer = null;
        }
        if (id === this.roadLayerId) {
          this.roadLayerId = null;
          this.roadGroupLayer = null;
        }
        if (!this.keneirinLayerId && !this.roadLayerId) {
          this.isLoaded = false;
          this._updateButtonState(false);
        }
      });

      GIS.AppState.on('allLayersCleared', () => {
        this._handleAllLayersUnloaded();
      });

      GIS.AppState.on('layerToggled', ({ id, visible }) => {
        if (id === this.roadLayerId) {
          const map = GIS.AppState.map;
          if (!map || !this.roadGroupLayer) return;

          if (visible) {
            if (map.getZoom() < MIN_ZOOM_LEVEL) {
              if (map.hasLayer(this.roadGroupLayer)) {
                map.removeLayer(this.roadGroupLayer);
              }
              if (GIS.UI && GIS.UI.showToast) {
                GIS.UI.showToast(`ℹ️ 「林道」はズームレベル${MIN_ZOOM_LEVEL}以上で表示されます（現在: ${map.getZoom()}）`, 'info');
              }
            }
          }
        }
      });
    },

    /**
     * レイヤー解除時のクリーンアップ
     */
    _handleAllLayersUnloaded: function () {
      this.isLoaded = false;
      this.keneirinLayerId = null;
      this.roadLayerId = null;
      this.keneirinGroupLayer = null;
      this.roadGroupLayer = null;
      this._updateButtonState(false);
    },

    /**
     * 追加／解除の切り替え
     */
    toggleForestRoads: async function () {
      if (this.isLoaded && (this.keneirinLayerId || this.roadLayerId)) {
        this.unloadForestRoads();
      } else {
        await this.loadForestRoads();
      }
    },

    /**
     * 県営林・林道レイヤーを解除
     */
    unloadForestRoads: function () {
      if (this.roadLayerId) {
        GIS.AppState.removeLayer(this.roadLayerId);
      }
      if (this.keneirinLayerId) {
        GIS.AppState.removeLayer(this.keneirinLayerId);
      }
      this._handleAllLayersUnloaded();
      if (GIS.UI && GIS.UI.showToast) {
        GIS.UI.showToast('🗑 「県営林・林道」レイヤーを解除しました');
      }
    },

    /**
     * keneirin.geojson データの取得（file:// CORS 制約時は keneirin.js にフォールバック）
     */
    _fetchKeneirinData: async function () {
      if (this.rawKeneirinGeoJSON) return this.rawKeneirinGeoJSON;
      if (window.KENEIRIN_GEOJSON) {
        this.rawKeneirinGeoJSON = window.KENEIRIN_GEOJSON;
        return this.rawKeneirinGeoJSON;
      }

      // まず fetch('data/keneirin.geojson') を試行
      try {
        const res = await fetch('data/keneirin.geojson');
        if (res.ok) {
          const json = await res.json();
          this.rawKeneirinGeoJSON = json;
          return json;
        }
      } catch (err) {
        console.warn('[ForestRoad] fetch(data/keneirin.geojson) failed (likely file:// protocol), trying script tag fallback...', err);
      }

      // file:// プロトコル等で fetch が CORS 制限された場合は data/keneirin.js を動的スクリプト読み込み
      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'data/keneirin.js';
        script.onload = () => {
          if (window.KENEIRIN_GEOJSON) {
            this.rawKeneirinGeoJSON = window.KENEIRIN_GEOJSON;
            resolve(window.KENEIRIN_GEOJSON);
          } else {
            reject(new Error('keneirin.js loaded but window.KENEIRIN_GEOJSON is undefined'));
          }
        };
        script.onerror = () => {
          reject(new Error('data/keneirin.geojson および data/keneirin.js の読み込みに失敗しました。'));
        };
        document.head.appendChild(script);
      });
    },

    /**
     * road.geojson データの取得（file:// CORS 制約時は road.js にフォールバック）
     */
    _fetchRoadData: async function () {
      if (this.rawRoadGeoJSON) return this.rawRoadGeoJSON;
      if (window.ROAD_GEOJSON) {
        this.rawRoadGeoJSON = window.ROAD_GEOJSON;
        return this.rawRoadGeoJSON;
      }

      // まず fetch('data/road.geojson') を試行
      try {
        const res = await fetch('data/road.geojson');
        if (res.ok) {
          const json = await res.json();
          this.rawRoadGeoJSON = json;
          return json;
        }
      } catch (err) {
        console.warn('[ForestRoad] fetch(data/road.geojson) failed (likely file:// protocol), trying script tag fallback...', err);
      }

      // file:// プロトコル等で fetch が CORS 制限された場合は data/road.js を動的スクリプト読み込み
      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'data/road.js';
        script.onload = () => {
          if (window.ROAD_GEOJSON) {
            this.rawRoadGeoJSON = window.ROAD_GEOJSON;
            resolve(window.ROAD_GEOJSON);
          } else {
            reject(new Error('road.js loaded but window.ROAD_GEOJSON is undefined'));
          }
        };
        script.onerror = () => {
          reject(new Error('data/road.geojson および data/road.js の読み込みに失敗しました。'));
        };
        document.head.appendChild(script);
      });
    },

    /**
     * 県営林・林道レイヤーの読み込み
     * 「県営林」を奥（pane: keneirinPane, zIndex: 410）、「林道」を手前（pane: forestRoadPane, zIndex: 425）に配置
     */
    loadForestRoads: async function () {
      const map = GIS.AppState.map;
      if (!map) return;

      const btn = document.getElementById('btn-load-forest-roads');
      if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ データを読み込み中...';
      }

      try {
        // カスタムペインの作成（奥: 県営林 zIndex 410, 手前: 林道 zIndex 425）
        if (!map.getPane('keneirinPane')) {
          const kPane = map.createPane('keneirinPane');
          kPane.style.zIndex = 410; // basemapPane(100)の上、林道(425)の下
        }
        if (!map.getPane('forestRoadPane')) {
          const rPane = map.createPane('forestRoadPane');
          rPane.style.zIndex = 425; // keneirinPane(410)の上
        }

        // 両データを並行ロード
        const [keneirinData, roadData] = await Promise.all([
          this._fetchKeneirinData(),
          this._fetchRoadData()
        ]);

        const keneirinCount = (keneirinData.features || []).length;
        const roadCount = (roadData.features || []).length;
        if (!keneirinCount && !roadCount) throw new Error('データにフィーチャが存在しません。');

        // ==========================================
        // 1. 県営林（keneirin.geojson）ポリゴンレイヤー（奥に配置）
        // ==========================================
        const onEachKeneirinFeature = (feature, layer) => {
          const p = feature.properties || {};
          const kouza = p['口座番号'] || '';
          const titleText = kouza ? `口座番号: ${kouza}` : '県営林（口座番号なし）';

          const popupContent = `
            <div class="keneirin-popup">
              <div class="keneirin-popup-header">
                <span class="keneirin-badge">県営林</span>
                <strong class="keneirin-title">${escapeHtml(titleText)}</strong>
              </div>
              <div class="keneirin-popup-body">
                <div class="keneirin-prop-row">
                  <span class="prop-label">口座番号</span>
                  <span class="prop-val">${escapeHtml(kouza || '未設定')}</span>
                </div>
              </div>
            </div>
          `;
          layer.bindPopup(popupContent, { maxWidth: 280, className: 'keneirin-leaflet-popup' });

          layer.bindTooltip(`🌲 県営林 (口座番号: ${escapeHtml(kouza || '未設定')})`, {
            sticky: true,
            className: 'keneirin-tooltip'
          });
        };

        const keneirinLayer = L.geoJSON(keneirinData, {
          pane: 'keneirinPane',
          style: {
            color: '#1B5E20',       // 濃緑の境界線
            weight: 1.5,
            opacity: 0.9,
            fillColor: '#2E7D32',   // 深みのある森林グリーン
            fillOpacity: 0.1,       // 透過度90%（不透過度10%）
            className: 'keneirin-polygon-layer'
          },
          onEachFeature: (feature, layer) => {
            onEachKeneirinFeature(feature, layer);
            layer.on({
              mouseover: (e) => {
                const target = e.target;
                target.setStyle({
                  fillOpacity: 0.25,
                  weight: 2.5,
                  color: '#004D40'
                });
                if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) {
                  target.bringToFront();
                }
              },
              mouseout: (e) => {
                keneirinLayer.resetStyle(e.target);
              }
            });
          }
        });
        this.keneirinGroupLayer = keneirinLayer;

        // ==========================================
        // 2. 林道（road.geojson）ラインレイヤー（手前に配置）
        // ==========================================
        const onEachRoadFeature = (feature, layer) => {
          const p = feature.properties || {};
          const name = p['路線名'] || p.name || '名称不明';
          const kanri = p['管理者'] || '不明';
          const encho = p['延長'] ? `${Number(p['延長']).toLocaleString()} m` : '—';

          const popupContent = `
            <div class="forest-road-popup">
              <div class="forest-road-popup-header">
                <span class="forest-road-badge">林道</span>
                <strong class="forest-road-title">${escapeHtml(name)}</strong>
              </div>
              <div class="forest-road-popup-body">
                <div class="forest-road-prop-row">
                  <span class="prop-label">路線名</span>
                  <span class="prop-val">${escapeHtml(name)}</span>
                </div>
                <div class="forest-road-prop-row">
                  <span class="prop-label">管理者</span>
                  <span class="prop-val">${escapeHtml(kanri)}</span>
                </div>
                <div class="forest-road-prop-row">
                  <span class="prop-label">延長</span>
                  <span class="prop-val">${escapeHtml(encho)}</span>
                </div>
              </div>
            </div>
          `;
          layer.bindPopup(popupContent, { maxWidth: 280, className: 'forest-road-leaflet-popup' });

          layer.bindTooltip(`🛣️ ${escapeHtml(name)} (${escapeHtml(kanri)})`, {
            sticky: true,
            className: 'forest-road-tooltip'
          });
        };

        // 1. 下地線（ホワイトハロー / 視認性確保用ケーシング: 透過度50%）
        const casingLayer = L.geoJSON(roadData, {
          pane: 'forestRoadPane',
          style: {
            color: '#FFFFFF',
            weight: 7.5,
            opacity: 0.5,
            lineCap: 'round',
            lineJoin: 'round',
            interactive: false
          }
        });

        // 2. 本線（茶色基調・バーントアンバー: 透過度50%）
        const coreLayer = L.geoJSON(roadData, {
          pane: 'forestRoadPane',
          style: {
            color: '#7B3F00',
            weight: 4.2,
            opacity: 0.5,
            lineCap: 'round',
            lineJoin: 'round',
            className: 'forest-road-interactive-line'
          },
          onEachFeature: (feature, layer) => {
            onEachRoadFeature(feature, layer);

            layer.on({
              mouseover: (e) => {
                const target = e.target;
                target.setStyle({
                  color: '#D84315',
                  weight: 6.0,
                  opacity: 0.8
                });
                if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) {
                  target.bringToFront();
                }
              },
              mouseout: (e) => {
                coreLayer.resetStyle(e.target);
              }
            });
          }
        });

        const roadGroup = L.featureGroup([casingLayer, coreLayer]);
        this.roadGroupLayer = roadGroup;

        // ==========================================
        // 3. レイヤー管理へ追加（県営林を先に追加し奥に、林道を後に追加し手前に）
        // ==========================================
        this.keneirinLayerId = GIS.AppState.addLayer({
          name: '県営林',
          type: 'geojson',
          layer: keneirinLayer,
          rawGeoJSON: keneirinData,
          editable: false
        });

        this.roadLayerId = GIS.AppState.addLayer({
          name: '林道',
          type: 'geojson',
          layer: roadGroup,
          rawGeoJSON: roadData
        });

        this.isLoaded = true;

        // ズームレベル監視（林道はズーム14以上で表示）
        this._setupZoomRestriction(map);

        // ボタン表示更新
        this._updateButtonState(true);

        const currentZoom = map.getZoom();
        if (currentZoom >= MIN_ZOOM_LEVEL) {
          if (GIS.UI && GIS.UI.showToast) {
            GIS.UI.showToast(`✅ 『県営林』(${keneirinCount}件)・『林道』(${roadCount}路線) を追加しました`, 'success');
          }
        } else {
          // 現在のズームが14未満の場合は林道グループを一時取り外し
          if (map.hasLayer(roadGroup)) {
            map.removeLayer(roadGroup);
          }
          if (GIS.UI && GIS.UI.showToast) {
            GIS.UI.showToast(`✅ 『県営林』(${keneirinCount}件)・『林道』を追加しました（※林道はズームレベル${MIN_ZOOM_LEVEL}以上で表示されます）`, 'info');
          }
        }

      } catch (err) {
        console.error('[ForestRoad] Error loading forest data:', err);
        if (GIS.UI && GIS.UI.showToast) {
          GIS.UI.showToast(`❌ 県営林・林道データの読み込みエラー: ${err.message}`, 'error');
        }
      } finally {
        if (btn) btn.disabled = false;
      }
    },

    /**
     * ズームレベル14以上の表示制御リスナーを設定（林道用）
     */
    _setupZoomRestriction: function (map) {
      if (this._zoomListenerAttached) return;
      this._zoomListenerAttached = true;

      const updateZoomVisibility = () => {
        if (!this.roadLayerId || !this.roadGroupLayer) return;
        const entry = GIS.AppState.layers.get(this.roadLayerId);
        if (!entry) return;

        // ユーザーがレイヤーリストで非表示にしていない場合のみ制御
        if (entry.visible) {
          const zoom = map.getZoom();
          if (zoom >= MIN_ZOOM_LEVEL) {
            if (!map.hasLayer(this.roadGroupLayer)) {
              map.addLayer(this.roadGroupLayer);
            }
          } else {
            if (map.hasLayer(this.roadGroupLayer)) {
              map.removeLayer(this.roadGroupLayer);
            }
          }
        }
      };

      map.on('zoomend', updateZoomVisibility);
    },

    /**
     * ボタンのUI状態更新
     */
    _updateButtonState: function (loaded) {
      const btn = document.getElementById('btn-load-forest-roads');
      if (!btn) return;
      if (loaded) {
        btn.textContent = '❌ 林道解除';
        btn.classList.add('active');
      } else {
        btn.textContent = '🛣️ 県営林・林道';
        btn.classList.remove('active');
      }
    }
  };

  // DOMロード時に自動初期化
  document.addEventListener('DOMContentLoaded', () => {
    GIS.ForestRoadHandler.init();
  });

})(window.GIS = window.GIS || {});
