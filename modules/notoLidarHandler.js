/**
 * modules/notoLidarHandler.js
 * 能登半島LiDARデータレイヤー一括制御＆左下折りたたみ凡例モジュール
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  // ============================================================
  // 1. DCHM T-RGB → 樹高グレースケール TileLayer クラス定義
  // ============================================================
  const TerrainGray = L.TileLayer.extend({
    createTile: function (coords, done) {
      const tile = document.createElement('canvas');
      tile.width = 256;
      tile.height = 256;
      const ctx = tile.getContext('2d');

      const img = new Image();
      img.crossOrigin = 'Anonymous';

      img.onload = () => {
        ctx.drawImage(img, 0, 0);
        const imgData = ctx.getImageData(0, 0, 256, 256);
        const data = imgData.data;

        for (let i = 0; i < data.length; i += 4) {
          const R = data[i];
          const G = data[i + 1];
          const B = data[i + 2];

          const height = (R * 256 * 256 + G * 256 + B) * 0.1 - 10000;
          const h = Math.max(0, Math.min(50, height));

          let gray = (h / 50) * 255;
          gray = 255 - gray;

          const alpha = Math.floor((h / 50) * 255);

          data[i] = gray;
          data[i + 1] = gray;
          data[i + 2] = gray;
          data[i + 3] = alpha;
        }

        ctx.putImageData(imgData, 0, 0);
        done(null, tile);
      };

      img.onerror = () => done(null, tile);
      img.src = this.getTileUrl(coords);
      return tile;
    }
  });

  // ============================================================
  // 2. 地形変化量 T-RGB → 赤〜透明〜青 TileLayer クラス定義
  // ============================================================
  const HenkaRB = L.TileLayer.extend({
    createTile: function (coords, done) {
      const tile = document.createElement('canvas');
      tile.width = 256;
      tile.height = 256;
      const ctx = tile.getContext('2d');

      const img = new Image();
      img.crossOrigin = 'Anonymous';

      img.onload = () => {
        ctx.drawImage(img, 0, 0);
        const imgData = ctx.getImageData(0, 0, 256, 256);
        const data = imgData.data;

        for (let i = 0; i < data.length; i += 4) {
          const R = data[i];
          const G = data[i + 1];
          const B = data[i + 2];

          const value = (R * 256 * 256 + G * 256 + B) * 0.1 - 10000;
          const v = Math.max(-20, Math.min(20, value));

          let r = 0, g = 0, b = 0, a = 255;

          if (v >= -1 && v <= 1) {
            a = 0;
          } else if (v < -1) {
            r = 255; g = 0; b = 0;
            a = 128; // 透過度50%（半透明）に設定
          } else if (v > 1) {
            const t = (v - 1) / 19;
            r = 0; g = 0; b = 255;
            a = Math.floor(t * 255);
          }

          data[i] = r;
          data[i + 1] = g;
          data[i + 2] = b;
          data[i + 3] = a;
        }

        ctx.putImageData(imgData, 0, 0);
        done(null, tile);
      };

      img.onerror = () => done(null, tile);
      img.src = this.getTileUrl(coords);
      return tile;
    }
  });

  // ============================================================
  // 3. モジュール定義
  // ============================================================
  GIS.NotoLidarHandler = {
    isLoaded: false,
    layerIds: [], // 登録された AppState の layer ID 配列
    treeStyleJson: null,
    handokuStyleJson: null,

    init: function () {
      this._bindAccordion();
      this._bindLegendPanel();
      this._listenAppStateEvents();
    },

    /**
     * アコーディオン UI の初期化
     */
    _bindAccordion: function () {
      const toggleBtn = document.getElementById('noto-lidar-toggle-btn');
      const content = document.getElementById('noto-lidar-content');
      const actionBtn = document.getElementById('btn-load-noto-lidar');

      if (toggleBtn && content) {
        toggleBtn.addEventListener('click', () => {
          const isHidden = content.classList.contains('hidden');
          if (isHidden) {
            content.classList.remove('hidden');
            toggleBtn.setAttribute('aria-expanded', 'true');
            toggleBtn.classList.add('open');
          } else {
            content.classList.add('hidden');
            toggleBtn.setAttribute('aria-expanded', 'false');
            toggleBtn.classList.remove('open');
          }
        });
      }

      if (actionBtn) {
        actionBtn.addEventListener('click', () => {
          this.toggleLayers();
        });
      }
    },

    /**
     * 左下凡例パネルの初期化
     */
    _bindLegendPanel: function () {
      const header = document.getElementById('noto-legend-header');
      const body = document.getElementById('noto-legend-body');

      if (header && body) {
        header.addEventListener('click', () => {
          const isHidden = body.classList.contains('hidden');
          if (isHidden) {
            body.classList.remove('hidden');
            header.classList.remove('collapsed');
          } else {
            body.classList.add('hidden');
            header.classList.add('collapsed');
          }
        });
      }
    },

    /**
     * AppState イベントの購読
     */
    _listenAppStateEvents: function () {
      GIS.AppState.on('layerRemoved', ({ id }) => {
        if (this.layerIds.includes(id)) {
          this.layerIds = this.layerIds.filter(lId => lId !== id);
          if (this.layerIds.length === 0) {
            this.isLoaded = false;
            this._updateButtonState(false);
            this.updateLegend();
          }
        }
      });

      GIS.AppState.on('layerToggled', () => {
        this.updateLegend();
      });

      GIS.AppState.on('allLayersCleared', () => {
        this.layerIds = [];
        this.isLoaded = false;
        this._updateButtonState(false);
        this.updateLegend();
      });
    },

    /**
     * レイヤーの追加／一括解除切り替え
     */
    toggleLayers: async function () {
      if (this.isLoaded) {
        this.unloadLayers();
      } else {
        await this.loadLayers();
      }
    },

    /**
     * 能登半島LiDARレイヤーの一括ロード
     */
    loadLayers: async function () {
      const map = GIS.AppState.map;
      if (!map) return;

      const actionBtn = document.getElementById('btn-load-noto-lidar');
      if (actionBtn) {
        actionBtn.disabled = true;
        actionBtn.textContent = '⏳ 読み込み中...';
      }

      try {
        // 1. CS立体図
        const csLayer = L.tileLayer(
          'https://rinya-tiles.geospatial.jp/csmap_r06eq_2025/{z}/{x}/{y}.webp',
          { attribution: '林野庁・CS立体図', maxZoom: 30, maxNativeZoom: 18, opacity: 0.5 }
        );
        const idCS = GIS.AppState.addLayer({
          name: 'CS立体図 (林野庁)',
          type: 'tile',
          layer: csLayer
        });
        this.layerIds.push(idCS);

        // 2. DCHM グレースケール加工
        const dchmGrayLayer = new TerrainGray(
          'https://forestgeo.info/opendata/17_ishikawa/noto/dchm_terrainRGB_2024/{z}/{x}/{y}.png',
          { attribution: 'DCHM グレースケール加工', maxZoom: 30, maxNativeZoom: 18 }
        );
        const idDCHM = GIS.AppState.addLayer({
          name: 'DCHM グレースケール加工',
          type: 'tile',
          layer: dchmGrayLayer
        });
        this.layerIds.push(idDCHM);

        // 3. 地形変化量 2色スケール加工
        const henkaRBLayer = new HenkaRB(
          'https://forestgeo.info/opendata/17_ishikawa/noto/henka_terrainRGB_2024/{z}/{x}/{y}.png',
          { attribution: '地形変化量 2色スケール加工', maxZoom: 30, maxNativeZoom: 18 }
        );
        const idHenka = GIS.AppState.addLayer({
          name: '地形変化量 2色スケール加工',
          type: 'tile',
          layer: henkaRBLayer
        });
        this.layerIds.push(idHenka);

        // 4. 簡易オルソ
        const orthoLayer = L.tileLayer(
          'https://forestgeo.info/opendata/17_ishikawa/noto/orthophoto_2024/{z}/{x}/{y}.webp',
          { attribution: '林野庁・簡易オルソ画像（2024）', maxZoom: 30, maxNativeZoom: 18 }
        );
        const idOrtho = GIS.AppState.addLayer({
          name: '簡易オルソ (2024)',
          type: 'tile',
          layer: orthoLayer
        });
        this.layerIds.push(idOrtho);

        // 5. 樹種2024 (VectorGrid)
        if (typeof L.vectorGrid !== 'undefined') {
          try {
            if (!this.treeStyleJson) {
              const res = await fetch('https://forestgeo.info/opendata/17_ishikawa/noto/treespecies_2024/style.json');
              this.treeStyleJson = await res.json();
            }
            const treeStyle = this._createTreeSpeciesVectorStyle(this.treeStyleJson);
            const treeLayer = L.vectorGrid.protobuf(
              'https://forestgeo.info/opendata/17_ishikawa/noto/treespecies_2024/{z}/{x}/{y}.pbf',
              {
                vectorTileLayerStyles: { '樹種ポリゴン': treeStyle },
                maxZoom: 30, minZoom: 8, interactive: false
              }
            );

            const idTree = GIS.AppState.addLayer({
              name: '樹種2024 (ベクトルタイル)',
              type: 'vectorgrid',
              layer: treeLayer
            });
            this.layerIds.push(idTree);
          } catch (e) {
            console.error('樹種2024読み込みエラー:', e);
          }

          // 6. 判読図2024 (VectorGrid)
          try {
            if (!this.handokuStyleJson) {
              const res = await fetch('https://forestgeo.info/opendata/17_ishikawa/noto/handoku_2024/style.json');
              this.handokuStyleJson = await res.json();
            }
            const handokuStyles = this._convertHandokuStyles(this.handokuStyleJson);
            const handokuLayer = L.vectorGrid.protobuf(
              'https://forestgeo.info/opendata/17_ishikawa/noto/handoku_2024/{z}/{x}/{y}.pbf',
              {
                vectorTileLayerStyles: handokuStyles,
                maxZoom: 30, minZoom: 12, interactive: false
              }
            );

            const idHandoku = GIS.AppState.addLayer({
              name: '判読図2024 (ベクトルタイル)',
              type: 'vectorgrid',
              layer: handokuLayer
            });
            this.layerIds.push(idHandoku);
          } catch (e) {
            console.error('判読図2024読み込みエラー:', e);
          }
        }

        // 中心移動（能登半島付近: 石川県）
        map.setView([37.3, 137.0], 10);

        this.isLoaded = true;
        this._updateButtonState(true);
        this.updateLegend();

        if (GIS.UI && GIS.UI.showToast) {
          GIS.UI.showToast('🌲 能登半島LiDARレイヤーを追加しました');
        }

      } catch (err) {
        console.error('能登半島LiDARデータの読み込みに失敗しました:', err);
        if (GIS.UI && GIS.UI.showToast) {
          GIS.UI.showToast('❌ データ読み込みエラーが発生しました');
        }
      } finally {
        if (actionBtn) actionBtn.disabled = false;
      }
    },

    /**
     * 能登半島LiDARレイヤーの一括削除
     */
    unloadLayers: function () {
      const idsToRemove = [...this.layerIds];
      idsToRemove.forEach(id => {
        GIS.AppState.removeLayer(id);
      });
      this.layerIds = [];
      this.isLoaded = false;
      this._updateButtonState(false);
      this.updateLegend();

      if (GIS.UI && GIS.UI.showToast) {
        GIS.UI.showToast('🗑 能登半島LiDARレイヤーを解除しました');
      }
    },

    _updateButtonState: function (loaded) {
      const actionBtn = document.getElementById('btn-load-noto-lidar');
      if (!actionBtn) return;
      if (loaded) {
        actionBtn.textContent = '❌ LiDAR解除';
        actionBtn.classList.add('active');
      } else {
        actionBtn.textContent = '🌲 能登半島LiDAR';
        actionBtn.classList.remove('active');
      }
    },

    /**
     * VectorGrid スタイル生成（樹種2024）
     */
    _createTreeSpeciesVectorStyle: function (styleJson) {
      const colorMap = {};
      styleJson.layers.forEach(layer => {
        if (layer.type === 'fill') {
          colorMap[layer.id] = {
            color: layer.paint['fill-color'],
            opacity: layer.paint['fill-opacity'],
            filter: layer.filter
          };
        }
      });

      return function (properties) {
        const species = properties['解析樹種'] || properties['樹種'];
        if (!species) return { fill: false, stroke: false };

        const entry = Object.values(colorMap).find(e => {
          const filter = e.filter;
          return filter && filter[2] === species;
        });

        if (!entry) return { fill: false, stroke: false };

        return {
          fill: true,
          fillColor: entry.color,
          fillOpacity: 0.4,
          stroke: false
        };
      };
    },

    /**
     * VectorGrid スタイル生成（判読図2024）
     */
    _convertHandokuStyles: function (styleJson) {
      const styles = {};
      styleJson.layers.forEach(layer => {
        const src = layer['source-layer'];
        if (layer.type === 'fill') {
          styles[src] = {
            fill: true,
            fillColor: layer.paint['fill-color'],
            fillOpacity: layer.paint['fill-opacity'],
            stroke: false
          };
        }
        if (layer.type === 'line') {
          styles[src] = {
            stroke: true,
            color: layer.paint['line-color'],
            weight: layer.paint['line-width']
          };
        }
        if (layer.type === 'circle') {
          styles[src] = {
            fill: true,
            fillColor: layer.paint['circle-stroke-color'],
            fillOpacity: layer.paint['circle-opacity'],
            stroke: false
          };
        }
      });
      return styles;
    },

    /**
     * 左下凡例パネルの表示更新
     */
    updateLegend: function () {
      const legendPanel = document.getElementById('noto-legend-panel');
      const legendContent = document.getElementById('noto-legend-content');
      if (!legendPanel || !legendContent) return;

      let html = '';

      // AppStateから表示中の該当レイヤーをチェック
      const isTreeVisible = this.layerIds.some(id => {
        const layer = GIS.AppState.layers.get(id);
        return layer && layer.name.includes('樹種2024') && layer.visible;
      });

      const isHandokuVisible = this.layerIds.some(id => {
        const layer = GIS.AppState.layers.get(id);
        return layer && layer.name.includes('判読図2024') && layer.visible;
      });

      const isHenkaVisible = this.layerIds.some(id => {
        const layer = GIS.AppState.layers.get(id);
        return layer && layer.name.includes('地形変化量') && layer.visible;
      });

      // 1. 樹種2024 凡例
      if (isTreeVisible && this.treeStyleJson) {
        html += `<div class="legend-group">
          <div class="legend-group-title">🌲 樹種2024 凡例</div>
          <div class="legend-grid">`;
        this.treeStyleJson.layers.forEach(layer => {
          if (layer.type === 'fill') {
            html += `
              <div class="legend-item">
                <span class="legend-color-box" style="background:${layer.paint['fill-color']}; opacity:${layer.paint['fill-opacity']};"></span>
                <span class="legend-label">${layer.id}</span>
              </div>`;
          }
        });
        html += `</div></div>`;
      }

      // 2. 判読図2024 凡例
      if (isHandokuVisible && this.handokuStyleJson) {
        html += `<div class="legend-group">
          <div class="legend-group-title">🔍 判読図2024 凡例</div>
          <div class="legend-grid">`;
        this.handokuStyleJson.layers.forEach(layer => {
          if (layer.type === 'fill') {
            html += `
              <div class="legend-item">
                <span class="legend-color-box" style="background:${layer.paint['fill-color']}; opacity:${layer.paint['fill-opacity']};"></span>
                <span class="legend-label">${layer.id}</span>
              </div>`;
          } else if (layer.type === 'line') {
            html += `
              <div class="legend-item">
                <span class="legend-color-line" style="background:${layer.paint['line-color']};"></span>
                <span class="legend-label">${layer.id}</span>
              </div>`;
          }
        });
        html += `</div></div>`;
      }

      // 3. 地形変化量 凡例
      if (isHenkaVisible) {
        html += `<div class="legend-group">
          <div class="legend-group-title">⛰️ 地形変化量 (2色)</div>
          <div class="legend-grid">
            <div class="legend-item">
              <span class="legend-color-box" style="background:#ff0000;"></span>
              <span class="legend-label">侵食・沈下 (赤)</span>
            </div>
            <div class="legend-item">
              <span class="legend-color-box" style="background:#0000ff;"></span>
              <span class="legend-label">堆積・隆起 (青)</span>
            </div>
          </div>
        </div>`;
      }

      if (html) {
        legendContent.innerHTML = html;
        legendPanel.classList.remove('hidden');
      } else {
        legendContent.innerHTML = '';
        legendPanel.classList.add('hidden');
      }
    }
  };

  // DOMロード時に自動初期化
  document.addEventListener('DOMContentLoaded', () => {
    GIS.NotoLidarHandler.init();
  });

})(window.GIS = window.GIS || {});
