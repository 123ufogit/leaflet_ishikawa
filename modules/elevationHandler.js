/**
 * elevationHandler.js - 国土地理院DEMタイルの不可視取得・カーソル標高・ライン断面図作成
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  /** DEMタイルのズームレベル（14は全国をカバー） */
  const DEM_ZOOM = 14;

  /** タイルキャッシュ (key: "z/x/y", value: ImageData) */
  const tileCache = new Map();
  const MAX_CACHE_SIZE = 120;

  /** 緯度経度からタイル座標・ピクセル位置を計算 */
  function latLngToTilePixel(lat, lng, zoom) {
    const n = Math.pow(2, zoom);
    const rad = (lat * Math.PI) / 180;
    const xExact = ((lng + 180) / 360) * n;
    const yExact =
      ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;

    const tileX = Math.floor(xExact);
    const tileY = Math.floor(yExact);

    const pixelX = Math.min(255, Math.max(0, Math.floor((xExact - tileX) * 256)));
    const pixelY = Math.min(255, Math.max(0, Math.floor((yExact - tileY) * 256)));

    return { tileX, tileY, pixelX, pixelY };
  }

  /** GSI 標高PNGタイルからRGB値を標高(m)にデコード */
  function decodeElevationFromRgb(R, G, B) {
    // 海部または無効値フラグ (R=128, G=0, B=0)
    if (R === 128 && G === 0 && B === 0) return 0;

    const xVal = R * 65536 + G * 256 + B;
    if (xVal === 8388608) return 0; // 2^23 = 0m境界

    return xVal < 8388608 ? xVal * 0.01 : (xVal - 16777216) * 0.01;
  }

  GIS.ElevationHandler = {
    isProfileActive: false,
    _hoverMarker: null,
    _currentLineGeoJSON: null,
    _throttleTimer: null,

    init: function () {
      this._setupCursorElevationListener();
      this._bindProfileUI();
    },

    /**
     * 指定した緯度経度の標高（メートル）を国土地理院DEMタイルから非表示取得
     * @param {number} lat 
     * @param {number} lng 
     * @returns {Promise<number|null>}
     */
    getElevation: async function (lat, lng) {
      const { tileX, tileY, pixelX, pixelY } = latLngToTilePixel(lat, lng, DEM_ZOOM);
      const cacheKey = `${DEM_ZOOM}/${tileX}/${tileY}`;

      let imgData = tileCache.get(cacheKey);

      if (!imgData) {
        imgData = await this._fetchTileImageData(DEM_ZOOM, tileX, tileY);
        if (!imgData) return null;

        if (tileCache.size >= MAX_CACHE_SIZE) {
          const firstKey = tileCache.keys().next().value;
          tileCache.delete(firstKey);
        }
        tileCache.set(cacheKey, imgData);
      }

      const idx = (pixelY * 256 + pixelX) * 4;
      const R = imgData.data[idx];
      const G = imgData.data[idx + 1];
      const B = imgData.data[idx + 2];

      return decodeElevationFromRgb(R, G, B);
    },

    /**
     * DEMタイルのImageDataをCanvas経由で非表示フェッチ
     */
    _fetchTileImageData: function (z, x, y) {
      return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'Anonymous';
        img.src = `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${z}/${x}/${y}.png`;

        img.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = 256;
            canvas.height = 256;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const imgData = ctx.getImageData(0, 0, 256, 256);
            resolve(imgData);
          } catch (e) {
            resolve(null);
          }
        };

        img.onerror = () => {
          resolve(null);
        };
      });
    },

    /**
     * 地図マウス移動時のカーソル標高表示リスナー
     */
    _setupCursorElevationListener: function () {
      const map = GIS.AppState.map;
      const elElev = document.getElementById('status-elevation');
      if (!elElev) return;

      if (!map) {
        setTimeout(() => this._setupCursorElevationListener(), 500);
        return;
      }

      map.on('mousemove', (e) => {
        if (this._throttleTimer) return;
        this._throttleTimer = setTimeout(async () => {
          this._throttleTimer = null;
          try {
            const elev = await this.getElevation(e.latlng.lat, e.latlng.lng);
            if (elev != null && !isNaN(elev)) {
              elElev.textContent = `標高: ${elev.toFixed(1)} m`;
            } else {
              elElev.textContent = '標高: —';
            }
          } catch (err) {
            elElev.textContent = '標高: —';
          }
        }, 70);
      });

      map.on('mouseout', () => {
        elElev.textContent = '標高: —';
      });
    },

    /**
     * 断面図UIボタンおよびモーダルイベントのバインド
     */
    _bindProfileUI: function () {
      const profileBtn = document.getElementById('btn-draw-profile');
      const closeBtn = document.getElementById('btn-close-elevation-panel');

      if (profileBtn) {
        profileBtn.addEventListener('click', () => {
          this.activateProfileMode();
        });
      }

      if (closeBtn) {
        closeBtn.addEventListener('click', () => {
          this.closeProfilePanel();
        });
      }
    },

    /**
     * 作図ツールバー内の「📈 断面図」モードを起動
     */
    activateProfileMode: function () {
      if (GIS.PolygonDrawer) {
        GIS.PolygonDrawer.setMode('profile');
      }
    },

    /**
     * ラインから標高断面図を生成・表示
     * @param {Array<[number, number]>} latlngs [[lat, lng], ...]
     * @param {string} label 
     */
    generateProfileFromLine: async function (latlngs, label = '断面図ライン') {
      if (!Array.isArray(latlngs) || latlngs.length < 2) {
        if (GIS.UI && GIS.UI.showToast) {
          GIS.UI.showToast('⚠️ 断面図の作成には2点以上のラインが必要です', 'warning');
        }
        return;
      }

      if (GIS.UI && GIS.UI.showToast) {
        GIS.UI.showToast('📈 国土地理院DEMから標高データを取得中...', 'info');
      }

      // GeoJSON LineStringの作成 ([lng, lat])
      const lineCoords = latlngs.map(pt => [pt.lng != null ? pt.lng : pt[1], pt.lat != null ? pt.lat : pt[0]]);
      const lineString = turf.lineString(lineCoords);
      const totalDistKm = turf.length(lineString, { units: 'kilometers' });
      const totalDistM = totalDistKm * 1000;

      // サンプリング点数を決定（最小30点、最大150点）
      const stepCount = Math.min(150, Math.max(30, Math.floor(totalDistM / 15)));
      const stepM = totalDistM / (stepCount - 1);

      const profilePoints = [];

      for (let i = 0; i < stepCount; i++) {
        const currentDistKm = (i * stepM) / 1000;
        const pt = turf.along(lineString, currentDistKm, { units: 'kilometers' });
        const lng = pt.geometry.coordinates[0];
        const lat = pt.geometry.coordinates[1];

        const elev = await this.getElevation(lat, lng);

        profilePoints.push({
          distance: Math.round(i * stepM),
          elev: elev != null ? Math.round(elev * 10) / 10 : 0,
          lat,
          lng
        });
      }

      this._renderProfileChart(profilePoints, label, totalDistM);
    },

    /**
     * 画面下部に標高断面図SVGチャートを描画
     */
    _renderProfileChart: function (points, title, totalDistance) {
      const panel = document.getElementById('elevation-profile-panel');
      const container = document.getElementById('elevation-chart-container');
      const titleEl = document.getElementById('elevation-profile-title');
      const statsEl = document.getElementById('elevation-profile-stats');

      if (!panel || !container) return;

      const elevations = points.map(p => p.elev);
      const minElev = Math.min(...elevations);
      const maxElev = Math.max(...elevations);
      const elevDiff = Math.round((maxElev - minElev) * 10) / 10;

      if (titleEl) titleEl.textContent = `📈 標高断面図：${title}`;
      if (statsEl) {
        statsEl.innerHTML = `
          <span>総延長: <strong>${(totalDistance >= 1000 ? (totalDistance / 1000).toFixed(2) + ' km' : Math.round(totalDistance) + ' m')}</strong></span>
          <span>最高標高: <strong>${maxElev.toFixed(1)} m</strong></span>
          <span>最低標高: <strong>${minElev.toFixed(1)} m</strong></span>
          <span>標高差: <strong>${elevDiff} m</strong></span>
        `;
      }

      // SVG描画
      const width = container.clientWidth || 700;
      const height = 180;
      const padLeft = 55;
      const padRight = 30;
      const padTop = 20;
      const padBottom = 35;

      const plotW = width - padLeft - padRight;
      const plotH = height - padTop - padBottom;

      const elevRange = (maxElev - minElev) || 10;
      const yMin = Math.floor(minElev - elevRange * 0.1);
      const yMax = Math.ceil(maxElev + elevRange * 0.1);
      const totalYRange = yMax - yMin;

      const polyPoints = points.map((p, idx) => {
        const x = padLeft + (idx / (points.length - 1)) * plotW;
        const y = padTop + plotH - ((p.elev - yMin) / totalYRange) * plotH;
        return { x, y, ...p };
      });

      const lineD = polyPoints.reduce((acc, p, i) => `${acc} ${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`, '');
      const areaD = `${lineD} L ${polyPoints[polyPoints.length - 1].x.toFixed(1)} ${padTop + plotH} L ${polyPoints[0].x.toFixed(1)} ${padTop + plotH} Z`;

      container.innerHTML = `
        <svg viewBox="0 0 ${width} ${height}" class="elevation-svg">
          <defs>
            <linearGradient id="elevationAreaGrad" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stop-color="#00D4FF" stop-opacity="0.45"/>
              <stop offset="100%" stop-color="#00D4FF" stop-opacity="0.05"/>
            </linearGradient>
          </defs>

          <!-- グリッド線とY軸ラベル -->
          <line x1="${padLeft}" y1="${padTop}" x2="${width - padRight}" y2="${padTop}" stroke="rgba(255,255,255,0.1)" stroke-dasharray="3,3"/>
          <text x="${padLeft - 8}" y="${padTop + 4}" class="chart-axis-label" text-anchor="end">${yMax}m</text>

          <line x1="${padLeft}" y1="${padTop + plotH / 2}" x2="${width - padRight}" y2="${padTop + plotH / 2}" stroke="rgba(255,255,255,0.1)" stroke-dasharray="3,3"/>
          <text x="${padLeft - 8}" y="${padTop + plotH / 2 + 4}" class="chart-axis-label" text-anchor="end">${Math.round((yMax + yMin) / 2)}m</text>

          <line x1="${padLeft}" y1="${padTop + plotH}" x2="${width - padRight}" y2="${padTop + plotH}" stroke="rgba(255,255,255,0.2)"/>
          <text x="${padLeft - 8}" y="${padTop + plotH + 4}" class="chart-axis-label" text-anchor="end">${yMin}m</text>

          <!-- X軸ラベル -->
          <text x="${padLeft}" y="${height - 8}" class="chart-axis-label" text-anchor="start">0 m</text>
          <text x="${width - padRight}" y="${height - 8}" class="chart-axis-label" text-anchor="end">${(totalDistance >= 1000 ? (totalDistance / 1000).toFixed(1) + 'km' : Math.round(totalDistance) + 'm')}</text>

          <!-- 塗りつぶし領域と折れ線 -->
          <path d="${areaD}" fill="url(#elevationAreaGrad)" />
          <path d="${lineD}" fill="none" stroke="#00D4FF" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />

          <!-- インタラクティブホバー線＆円 -->
          <g id="chart-hover-indicator" style="display: none;">
            <line id="chart-hover-line" x1="0" y1="${padTop}" x2="0" y2="${padTop + plotH}" stroke="#FFD700" stroke-width="1.5" stroke-dasharray="2,2"/>
            <circle id="chart-hover-circle" cx="0" cy="0" r="4.5" fill="#FFD700" stroke="#000" stroke-width="1.5"/>
            <text id="chart-hover-text" x="0" y="0" class="chart-hover-label" text-anchor="middle"></text>
          </g>
        </svg>
      `;

      // チャート上のホバーイベントで地図上の位置と連動
      this._bindChartHover(container, polyPoints, padLeft, plotW);

      panel.classList.remove('hidden');
    },

    _bindChartHover: function (container, polyPoints, padLeft, plotW) {
      const map = GIS.AppState.map;
      const indicator = container.querySelector('#chart-hover-indicator');
      const hoverLine = container.querySelector('#chart-hover-line');
      const hoverCircle = container.querySelector('#chart-hover-circle');
      const hoverText = container.querySelector('#chart-hover-text');

      container.onmousemove = (e) => {
        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;

        if (mouseX < padLeft || mouseX > padLeft + plotW) {
          if (indicator) indicator.style.display = 'none';
          this._removeHoverMarker();
          return;
        }

        const ratio = (mouseX - padLeft) / plotW;
        const idx = Math.min(polyPoints.length - 1, Math.max(0, Math.round(ratio * (polyPoints.length - 1))));
        const pt = polyPoints[idx];

        if (indicator && hoverLine && hoverCircle && hoverText) {
          indicator.style.display = '';
          hoverLine.setAttribute('x1', pt.x);
          hoverLine.setAttribute('x2', pt.x);
          hoverCircle.setAttribute('cx', pt.x);
          hoverCircle.setAttribute('cy', pt.y);

          hoverText.setAttribute('x', pt.x);
          hoverText.setAttribute('y', Math.max(16, pt.y - 10));
          hoverText.textContent = `${pt.distance}m : ${pt.elev}m`;
        }

        // 地図上の連動マーカー
        if (map) {
          if (!this._hoverMarker) {
            const icon = L.divIcon({
              className: 'elevation-map-hover-icon',
              html: '<div class="elevation-hover-dot"></div>',
              iconSize: [16, 16],
              iconAnchor: [8, 8]
            });
            this._hoverMarker = L.marker([pt.lat, pt.lng], { icon, interactive: false }).addTo(map);
          } else {
            this._hoverMarker.setLatLng([pt.lat, pt.lng]);
          }
        }
      };

      container.onmouseleave = () => {
        if (indicator) indicator.style.display = 'none';
        this._removeHoverMarker();
      };
    },

    _removeHoverMarker: function () {
      const map = GIS.AppState.map;
      if (this._hoverMarker && map && map.hasLayer(this._hoverMarker)) {
        map.removeLayer(this._hoverMarker);
        this._hoverMarker = null;
      }
    },

    closeProfilePanel: function () {
      const panel = document.getElementById('elevation-profile-panel');
      if (panel) panel.classList.add('hidden');
      this._removeHoverMarker();
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    GIS.ElevationHandler.init();
  });

})(window.GIS = window.GIS || {});
