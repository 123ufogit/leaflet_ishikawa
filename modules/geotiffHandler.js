/**
 * geotiffHandler.js - GeoTIFFファイルのデコードと地図オーバーレイ表示
 *
 * 【メモリ最適化】
 *   - fromBlob()              : file.arrayBuffer() を回避し初期メモリ削減
 *   - readRasters({w, h})    : 出力解像度で直接読み込みピーク使用量を大幅削減
 *   - チャンク分割描画         : UIスレッドをブロックしない
 *
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  /** geotiff.js ライブラリのCDN URL */
  const GEOTIFF_CDN = 'https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js';

  /** proj4.js ライブラリのCDN URL */
  const PROJ4_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.15.0/proj4.js';

  /**
   * 出力画像の最大解像度（ピクセル）
   * これを超える画像は readRasters の段階で縮小する（Canvas確保前に縮小）
   */
  const MAX_RESAMPLE_SIZE = 2048;

  let geotiffReady   = false;
  let geotiffLoading = false;
  let geotiffCallbacks = [];

  let proj4Ready   = false;
  let proj4Loading = false;
  let proj4Callbacks = [];

  /**
   * 日本の平面直交座標系（1系〜19系）の原点パラメータ
   * [北緯 lat, 東経 lon]
   */
  const JGD_PLANE_ZONES = {
    1:  { lat: 33.0, lon: 129.5 },
    2:  { lat: 33.0, lon: 131.0 },
    3:  { lat: 36.0, lon: 132 + 10 / 60 },
    4:  { lat: 33.0, lon: 133.5 },
    5:  { lat: 36.0, lon: 134 + 20 / 60 },
    6:  { lat: 36.0, lon: 136.0 },
    7:  { lat: 36.0, lon: 137 + 10 / 60 },
    8:  { lat: 36.0, lon: 138.5 },
    9:  { lat: 36.0, lon: 139 + 50 / 60 },
    10: { lat: 40.0, lon: 140 + 50 / 60 },
    11: { lat: 44.0, lon: 140.25 },
    12: { lat: 44.0, lon: 142.25 },
    13: { lat: 44.0, lon: 144.25 },
    14: { lat: 26.0, lon: 142.0 },
    15: { lat: 26.0, lon: 127.5 },
    16: { lat: 26.0, lon: 124.0 },
    17: { lat: 26.0, lon: 131.0 },
    18: { lat: 20.0, lon: 136.0 },
    19: { lat: 26.0, lon: 154.0 }
  };

  /**
   * 各ラスタタイプ専用のカラーパレット定義
   * p: 0.0〜1.0 の正規化位置, c: [r, g, b]
   */
  const COLOR_PALETTES = {
    // 1. CS立体図 (戸田式CS立体図に準拠: 谷(濃青〜水色) ➔ 平坦(アイボリー白) ➔ 尾根(橙〜深赤))
    cs: [
      { p: 0.00, c: [0, 45, 170] },     // 濃青 (最深谷部)
      { p: 0.25, c: [30, 144, 255] },   // 青〜シアン (谷部)
      { p: 0.45, c: [185, 230, 255] },  // 淡水色
      { p: 0.50, c: [255, 255, 245] },  // アイボリー白 (平坦・緩傾斜)
      { p: 0.55, c: [255, 235, 170] },  // 淡橙
      { p: 0.75, c: [255, 110, 0] },    // 橙 (尾根)
      { p: 1.00, c: [200, 0, 30] }      // 深紅 (突出尾根)
    ],

    // 2. TWI (Topographic Wetness Index / 地形湿潤指数: 乾燥(黄褐・砂色) ➔ 中庸 ➔ 湿潤・谷底(水色〜藍紺))
    twi: [
      { p: 0.00, c: [140, 81, 10] },    // 黄褐色・砂色 (極端な乾燥・山稜頂部)
      { p: 0.20, c: [216, 179, 101] },  // 砂ベージュ (乾燥斜面)
      { p: 0.40, c: [246, 232, 195] },  // 淡黄 (中庸)
      { p: 0.55, c: [199, 234, 229] },  // 淡青緑 (湿潤開始)
      { p: 0.72, c: [90, 180, 172] },   // 翡翠〜水色 (集水凹地)
      { p: 0.88, c: [1, 102, 94] },     // 濃青緑 (谷筋・水路)
      { p: 1.00, c: [8, 29, 88] }       // 藍紺 (最湿潤・流水集中域)
    ],

    // 3. 標高 (DEM: 低標高(深緑) ➔ 丘陵(淡黄緑) ➔ 山地(暖黄・橙) ➔ 高山(暗紅) ➔ 頂峰(雪白))
    dem: [
      { p: 0.00, c: [27, 120, 55] },    // 深緑 (低標高・平野部)
      { p: 0.20, c: [127, 191, 123] },  // 草色 (山麓)
      { p: 0.40, c: [217, 240, 163] },  // 淡黄緑 (丘陵)
      { p: 0.60, c: [254, 224, 139] },  // 暖黄 (中山部)
      { p: 0.75, c: [244, 109, 67] },   // 橙赤 (高山斜面)
      { p: 0.90, c: [165, 0, 38] },     // 暗紅 (稜線)
      { p: 1.00, c: [255, 255, 255] }   // 雪白 (最高峰)
    ],

    // 4. 傾斜量図 (平坦(白・淡黄) ➔ 緩傾斜(青緑) ➔ 中傾斜(橙) ➔ 急傾斜(赤) ➔ 崖(黒赤))
    slope: [
      { p: 0.00, c: [255, 255, 255] },  // 白 (0° 平坦)
      { p: 0.15, c: [237, 248, 177] },  // 淡黄 (緩傾斜)
      { p: 0.35, c: [127, 205, 187] },  // 青緑 (10〜20°)
      { p: 0.60, c: [254, 178, 76] },   // 橙 (20〜30°)
      { p: 0.80, c: [227, 26, 28] },    // 赤 (30〜45°)
      { p: 1.00, c: [103, 0, 13] }      // 黒赤 (45°以上 崖)
    ],

    // 5. 不明ラスタ用汎用カラースケール (Turbo: 濃紫 ➔ 青 ➔ シアン ➔ 緑 ➔ 黄 ➔ 橙 ➔ 暗紅)
    turbo: [
      { p: 0.00, c: [48, 18, 59] },     // 濃紫
      { p: 0.15, c: [70, 98, 215] },    // 青
      { p: 0.35, c: [26, 228, 182] },   // シアン
      { p: 0.55, c: [162, 252, 60] },   // 黄緑
      { p: 0.75, c: [250, 186, 57] },   // 橙黄
      { p: 0.90, c: [226, 58, 7] },     // 朱赤
      { p: 1.00, c: [122, 4, 3] }       // 暗紅
    ],

    // 6. 白黒グレースケール
    grayscale: [
      { p: 0.00, c: [0, 0, 0] },
      { p: 1.00, c: [255, 255, 255] }
    ]
  };

  const PALETTE_LABELS = {
    cs: '🗺️ CS立体図',
    twi: '🌊 TWI（地形湿潤指数）',
    dem: '⛰️ 標高 (DEM)',
    slope: '📐 傾斜量図',
    turbo: '🌈 Turbo (一般ラスタ)',
    grayscale: '⚪ 白黒グレースケール',
    photo: '📷 カラー写真・オルソ'
  };

  const _lutCache = {};

  function getColorLut(paletteName) {
    if (_lutCache[paletteName]) return _lutCache[paletteName];
    const stops = COLOR_PALETTES[paletteName] || COLOR_PALETTES.turbo;
    const lut = new Uint8ClampedArray(256 * 4);

    for (let i = 0; i < 256; i++) {
      const p = i / 255.0;
      let c0 = stops[0];
      let c1 = stops[stops.length - 1];

      for (let s = 0; s < stops.length - 1; s++) {
        if (stops[s].p <= p && p <= stops[s + 1].p) {
          c0 = stops[s];
          c1 = stops[s + 1];
          break;
        }
      }

      const span = c1.p - c0.p;
      const t = span <= 0 ? 0 : (p - c0.p) / span;
      lut[i * 4]     = Math.round(c0.c[0] + t * (c1.c[0] - c0.c[0]));
      lut[i * 4 + 1] = Math.round(c0.c[1] + t * (c1.c[1] - c0.c[1]));
      lut[i * 4 + 2] = Math.round(c0.c[2] + t * (c1.c[2] - c0.c[2]));
      lut[i * 4 + 3] = 255;
    }

    _lutCache[paletteName] = lut;
    return lut;
  }

  GIS.GeoTiffHandler = {

    /**
     * GeoTIFFヘッダー・タグ・メタデータおよびファイル名からラスタ種別を自動判別する
     * @param {GeoTIFF.GeoTIFFImage} image
     * @param {File} file
     * @returns {{type: string, label: string, paletteName: string, isMultiBand: boolean, description: string}}
     */
    detectRasterType(image, file) {
      const samplesPerPixel = image.getSamplesPerPixel();
      const fileDir = (typeof image.getFileDirectory === 'function') ? (image.getFileDirectory() || {}) : {};
      const photometric = fileDir.PhotometricInterpretation;
      const colorMap = fileDir.ColorMap;
      const desc = String(fileDir.ImageDescription || '');
      const meta = String(fileDir.GDAL_METADATA || '');
      const software = String(fileDir.Software || '');
      const fileName = file ? String(file.name || '') : '';
      const textToScan = `${fileName} ${desc} ${meta} ${software}`.toLowerCase();

      // 1. マルチバンドカラー画像（RGB / RGBA / YCbCr）
      if (samplesPerPixel >= 3 || photometric === 2 || photometric === 6) {
        if (/(?:^|[^a-zA-Z])cs(?:map|立体図|_|-|\.|$)|立体図|curvature/i.test(textToScan)) {
          return {
            type: 'cs',
            label: 'CS立体図 (RGBカラー)',
            paletteName: 'photo',
            isMultiBand: true,
            description: 'RGB合成済みCS立体図'
          };
        }
        return {
          type: 'photo',
          label: 'カラー写真・オルソ (RGB)',
          paletteName: 'photo',
          isMultiBand: true,
          description: '3バンド以上のフルカラー航空写真・オルソ画像'
        };
      }

      // 2. パレットカラー画像（PhotometricInterpretation = 3: Palette）
      if (photometric === 3 && colorMap && colorMap.length >= 3) {
        return {
          type: 'photo',
          label: 'パレットカラー画像',
          paletteName: 'palette',
          isMultiBand: false,
          colorMap: colorMap,
          description: 'インデックスカラーパレット画像'
        };
      }

      // 3. 単一バンド: CS立体図
      if (/(?:^|[^a-zA-Z])cs(?:map|立体図|_|-|\.|$)|立体図|曲率|curvature/i.test(textToScan)) {
        return {
          type: 'cs',
          label: 'CS立体図 (専用カラーコード)',
          paletteName: 'cs',
          isMultiBand: false,
          description: '谷(青)〜平坦(淡黄)〜尾根(赤)のCS立体図専用スタイル'
        };
      }

      // 4. 単一バンド: TWI (Topographic Wetness Index / 地形湿潤指数)
      if (/\b(?:twi|wetness|cti)\b|地形湿潤|湿潤指数|湿潤度/i.test(textToScan)) {
        return {
          type: 'twi',
          label: 'TWI (地形湿潤指数 専用カラーコード)',
          paletteName: 'twi',
          isMultiBand: false,
          description: '乾燥(黄褐)〜中庸(淡緑)〜湿潤(水色・濃青)のTWI専用ハイドロロジカルスタイル'
        };
      }

      // 5. 単一バンド: 標高データ (DEM / DTM / DSM)
      if (/\b(?:dem|dtm|dsm|elevation|elev|height|altitude)\b|標高|数値標高|地盤高|標高値/i.test(textToScan)) {
        return {
          type: 'dem',
          label: '標高データ (DEM専用カラーコード)',
          paletteName: 'dem',
          isMultiBand: false,
          description: '低地(緑)〜丘陵(黄緑)〜山地(橙)〜高所(暗紅・白)の地形グラデーション'
        };
      }

      // 6. 単一バンド: 傾斜量図 (Slope)
      if (/\b(?:slope|keisha|gradient)\b|傾斜|傾斜量/i.test(textToScan)) {
        return {
          type: 'slope',
          label: '傾斜量図 (傾斜専用カラーコード)',
          paletteName: 'slope',
          isMultiBand: false,
          description: '平坦(白)〜緩傾斜(黄)〜急傾斜(赤・暗赤)の傾斜角スタイル'
        };
      }

      // 7. 不明 / 一般ラスタ (Turboカラースケール)
      return {
        type: 'generic',
        label: '一般ラスタ (Turboカラースケール)',
        paletteName: 'turbo',
        isMultiBand: false,
        description: '高コントラストで連続変化が明瞭な知覚的一様カラースケール'
      };
    },

    /**
     * キャッシュされたラスタデータから指定パレットでCanvas描画を行いDataURLを生成
     * @param {object} info - entry.geotiffInfo
     * @param {string} paletteName - 'cs' | 'twi' | 'dem' | 'slope' | 'turbo' | 'grayscale'
     * @returns {string} DataURL (PNG)
     */
    renderRasterCanvas(info, paletteName) {
      const { rasterData, outW, outH, minVal, maxVal, noData, samplesPerPixel } = info;
      if (!rasterData) return null;

      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d');
      const imgData = ctx.createImageData(outW, outH);
      const buf = imgData.data;

      const span = (maxVal - minVal) > 0 ? (maxVal - minVal) : 1;
      const lut = getColorLut(paletteName);

      const total = outW * outH;
      for (let i = 0; i < total; i++) {
        let v;
        if (samplesPerPixel >= 3) {
          v = (rasterData[i * samplesPerPixel] + rasterData[i * samplesPerPixel + 1] + rasterData[i * samplesPerPixel + 2]) / 3;
        } else {
          v = rasterData[i];
        }

        const isNoData = (noData !== undefined && v === noData) || !isFinite(v);
        if (isNoData) {
          buf[i * 4 + 3] = 0;
        } else {
          const norm = Math.max(0, Math.min(1, (v - minVal) / span));
          const lutIdx = Math.floor(norm * 255) * 4;
          buf[i * 4]     = lut[lutIdx];
          buf[i * 4 + 1] = lut[lutIdx + 1];
          buf[i * 4 + 2] = lut[lutIdx + 2];
          buf[i * 4 + 3] = 255;
        }
      }

      ctx.putImageData(imgData, 0, 0);
      return canvas.toDataURL('image/png');
    },

    /**
     * レイヤーのカラースケール配色を変更して即時反映する
     * @param {string} layerId
     * @param {string} paletteName
     */
    applyPalette(layerId, paletteName) {
      const entry = GIS.AppState.layers.get(layerId);
      if (!entry || !entry.geotiffInfo) return;

      const info = entry.geotiffInfo;
      const dataUrl = this.renderRasterCanvas(info, paletteName);
      if (dataUrl) {
        entry.layer.setUrl(dataUrl);
        info.currentStyle = paletteName;
        info.mode = 'palette';

        if (GIS.UI && GIS.UI.showToast) {
          const label = PALETTE_LABELS[paletteName] || paletteName;
          GIS.UI.showToast(`🎨 配色スタイルを「${label}」に変更しました`, 'info');
        }
      }
    },

    /**
     * 元の自動判別スタイルに戻す
     * @param {string} layerId
     */
    restoreDetectedStyle(layerId) {
      const entry = GIS.AppState.layers.get(layerId);
      if (!entry || !entry.geotiffInfo) return;

      const info = entry.geotiffInfo;
      if (info.initialDataUrl) {
        entry.layer.setUrl(info.initialDataUrl);
        info.mode = 'detected';
        info.currentStyle = info.detectedType ? info.detectedType.paletteName : 'detected';

        if (GIS.UI && GIS.UI.showToast) {
          const label = info.detectedType ? info.detectedType.label : '自動判別スタイル';
          GIS.UI.showToast(`🎨 「${label}」に戻しました`, 'info');
        }
      }
    },

    /**
     * GeoTIFFファイルを読み込み、地図にオーバーレイ表示する
     * @param {File} file
     */
    async load(file) {
      const sizeMB = (file.size / 1024 / 1024).toFixed(1);

      GIS.UI.showProgress(
        '🛰️ GeoTIFF 読み込み中',
        `${file.name} (${sizeMB} MB)`
      );

      try {
        // Step 1: ライブラリ読み込み
        GIS.UI.updateProgress(5, 'geotiff.js ライブラリを準備中...');
        await this._ensureGeotiff();

        // Step 2: Blob URL 経由で TIFF を開く
        GIS.UI.updateProgress(15, `TIFFを開いています... (${sizeMB} MB)`);
        await this._yield();
        const tiff  = await window.GeoTIFF.fromBlob(file);
        const image = await tiff.getImage();

        // Step 3: 画像サイズを確認して出力解像度を決定
        GIS.UI.updateProgress(28, 'TIFFヘッダを解析中...');
        await this._yield();
        const origW = image.getWidth();
        const origH = image.getHeight();

        let outW = origW;
        let outH = origH;
        if (origW > MAX_RESAMPLE_SIZE || origH > MAX_RESAMPLE_SIZE) {
          const scale = MAX_RESAMPLE_SIZE / Math.max(origW, origH);
          outW = Math.max(1, Math.round(origW * scale));
          outH = Math.max(1, Math.round(origH * scale));
        }
        const isDownsampled = (outW !== origW || outH !== origH);

        if (isDownsampled) {
          GIS.UI.updateProgress(32,
            `大きな画像 (${origW}×${origH}px) → ${outW}×${outH}px に縮小して読み込みます`);
          await this._yield();
        }

        // Step 4: 地理参照情報とファイル種別を判定
        GIS.UI.updateProgress(36, '地理参照情報とファイル種別を解析中...');
        await this._yield();
        const boundsInfo = await this._extractBounds(image);
        if (!boundsInfo || !boundsInfo.bounds) {
          throw new Error(
            'GeoTIFFの地理参照情報が見つかりません。\n' +
            '対応座標系: WGS84, Web Mercator, JGD2011/JGD2000 平面直交座標系 (第1系〜第19系)'
          );
        }

        const { bounds, crsName } = boundsInfo;

        // ファイル種別（写真、CS立体図、TWI、DEM、傾斜、一般ラスタ等）の自動判別
        const detectedType = this.detectRasterType(image, file);

        // Step 5: ラスタを出力解像度で直接読み込んで Canvas 化（判別スタイルを適用）
        GIS.UI.updateProgress(45, `ラスタデータを読み込んでいます [${detectedType.label}]...`);
        const rasterResult = await this._rasterToCanvas(
          image, outW, outH, detectedType,
          (pct, msg) => GIS.UI.updateProgress(pct, msg)
        );

        const dataUrl = rasterResult.dataUrl;

        // Step 6: Leaflet へ追加
        GIS.UI.updateProgress(97, '地図に追加中...');
        await this._yield();

        // ラスターペインの存在確認・自動作成（未初期化時のエラー防止）
        const map = GIS.AppState.map;
        if (map && !map.getPane('rasterPane')) {
          try {
            const rPane = map.createPane('rasterPane');
            rPane.style.zIndex = 250;
          } catch (e) {
            console.warn('[GeoTIFF] rasterPane creation warning:', e);
          }
        }
        const targetPane = (map && map.getPane('rasterPane')) ? 'rasterPane' : 'overlayPane';

        const overlay = L.imageOverlay(dataUrl, bounds, {
          opacity: 0.5,
          interactive: true,
          pane: targetPane
        });

        const minV = (rasterResult.minVal !== Infinity) ? rasterResult.minVal : 0;
        const maxV = (rasterResult.maxVal !== -Infinity) ? rasterResult.maxVal : 255;

        const layerName = (GIS.FileHandler && GIS.FileHandler.stripExtension)
          ? GIS.FileHandler.stripExtension(file.name)
          : file.name.replace(/\.[^/.]+$/, '');

        const layerId = GIS.AppState.addLayer({
          name: layerName,
          type: 'geotiff',
          layer: overlay,
          file: file,
          geotiffInfo: {
            rasterData: rasterResult.rasterData,
            minVal: minV,
            maxVal: maxV,
            noData: rasterResult.noData,
            outW: outW,
            outH: outH,
            samplesPerPixel: rasterResult.samplesPerPixel,
            bounds: bounds,
            detectedType: detectedType,
            currentStyle: detectedType.paletteName,
            useForestMask: false,
            maskLayerId: document.getElementById('batch-mask-select')?.value || 'all',
            threshold: 4.0,
            colorLow: '#00d7ff',
            colorHigh: '#ffff00',
            opacity: 0.5,
            mode: 'detected',
            initialDataUrl: dataUrl
          }
        });

        // クリックポップアップの設定
        const buildPopupHtml = () => {
          const entry = GIS.AppState.layers.get(layerId);
          const currentStyle = (entry && entry.geotiffInfo) ? entry.geotiffInfo.currentStyle : detectedType.paletteName;
          return `
            <div class="geotiff-popup">
              <strong style="display:block;font-size:13px;margin-bottom:4px;">🛰️ ${GIS.UI.escHtml(file.name)}</strong>
              <div style="margin-bottom:3px;">
                種別: <span class="geotiff-type-badge">${GIS.UI.escHtml(detectedType.label)}</span>
              </div>
              <div>ファイルサイズ: ${sizeMB} MB</div>
              <div>座標系: <span style="color:#38bdf8;font-weight:600;">${GIS.UI.escHtml(crsName || '不明')}</span></div>
              <div>解像度: ${origW.toLocaleString()}×${origH.toLocaleString()}px</div>
              ${isDownsampled
                ? `<div>表示サイズ: ${outW.toLocaleString()}×${outH.toLocaleString()}px</div>
                   <div class="compressed-badge">縮小表示中</div>`
                : ''}
              ${rasterResult.minVal !== undefined && rasterResult.minVal !== Infinity
                ? `<div style="margin-top:4px;font-size:11px;color:#94a3b8;">値範囲: ${rasterResult.minVal.toFixed(2)} 〜 ${rasterResult.maxVal.toFixed(2)}</div>`
                : ''}
              ${!detectedType.isMultiBand ? `
                <div style="margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.15);">
                  <label style="font-size:11px;color:#94a3b8;display:block;margin-bottom:3px;">🎨 配色スタイルの変更:</label>
                  <select class="geotiff-palette-select" onchange="GIS.GeoTiffHandler.applyPalette('${layerId}', this.value)" style="width:100%;padding:4px 6px;border-radius:4px;background:#1e293b;color:#f8fafc;border:1px solid #475569;font-size:12px;cursor:pointer;">
                    <option value="cs" ${currentStyle === 'cs' ? 'selected' : ''}>🗺️ CS立体図 (専用カラーコード)</option>
                    <option value="twi" ${currentStyle === 'twi' ? 'selected' : ''}>🌊 TWI (地形湿潤指数)</option>
                    <option value="dem" ${currentStyle === 'dem' ? 'selected' : ''}>⛰️ 標高 (DEM地形グラデーション)</option>
                    <option value="slope" ${currentStyle === 'slope' ? 'selected' : ''}>📐 傾斜量図 (急傾斜強調)</option>
                    <option value="turbo" ${currentStyle === 'turbo' ? 'selected' : ''}>🌈 Turbo (一般ラスタ)</option>
                    <option value="grayscale" ${currentStyle === 'grayscale' ? 'selected' : ''}>⚪ 白黒グレースケール</option>
                  </select>
                </div>
              ` : ''}
            </div>
          `;
        };

        overlay.on('click', () => {
          L.popup()
            .setLatLng(bounds.getCenter())
            .setContent(buildPopupHtml())
            .openOn(GIS.AppState.map);
        });

        // 地図の表示範囲を調整
        GIS.AppState.map.fitBounds(bounds, { padding: [40, 40] });
        GIS.UI.hideProgress();
        GIS.UI.showToast(
          `✅ GeoTIFF読み込み完了 [${detectedType.label}]: ${file.name}`,
          'success'
        );

      } catch (err) {
        GIS.UI.hideProgress();
        throw err;
      }
    },

    // ------------------------------------------------------------------
    // 地理参照情報の取得
    // ------------------------------------------------------------------

    /**
     * GeoTIFFの地理参照情報からLeafletのLatLngBoundsとCRS情報を生成する
     * EPSG:4326, EPSG:3857, JGD2011/JGD2000 平面直交系（第1系〜第19系）に対応
     * @param {GeoTIFF.GeoTIFFImage} image
     * @returns {Promise<{bounds: L.LatLngBounds, crsName: string}|null>}
     */
    async _extractBounds(image) {
      try {
        const bbox = image.getBoundingBox(); // [minX, minY, maxX, maxY]
        if (!bbox || bbox.length < 4) return null;

        const [minX, minY, maxX, maxY] = bbox;
        const geoKeys = image.getGeoKeys() || {};
        let epsg = geoKeys.ProjectedCSTypeGeoKey || geoKeys.GeographicTypeGeoKey;

        // ProjectedCSTypeGeoKey が User-Defined (32767) または未定義の場合のフォールバックチェック
        if (!epsg || epsg === 32767) {
          if (geoKeys.ProjectionGeoKey && geoKeys.ProjectionGeoKey >= 16001 && geoKeys.ProjectionGeoKey <= 16019) {
            epsg = 2442 + (geoKeys.ProjectionGeoKey - 16000); // JGD2000 平面直交 1~19系
          } else if (geoKeys.ProjectionGeoKey && geoKeys.ProjectionGeoKey >= 16101 && geoKeys.ProjectionGeoKey <= 16119) {
            epsg = 6668 + (geoKeys.ProjectionGeoKey - 16100); // JGD2011 平面直交 1~19系
          }
        }

        // 1. 日本の平面直交系 (JGD2011: 6669~6687, JGD2000: 2443~2461)
        if (epsg && ((epsg >= 6669 && epsg <= 6687) || (epsg >= 2443 && epsg <= 2461))) {
          await this._ensureProj4();
          const projInfo = this._registerJgdPlaneZone(epsg);
          if (projInfo) {
            const bounds = this._convertPlaneBboxToBounds(minX, minY, maxX, maxY, projInfo.epsgStr);
            return { bounds, crsName: `${projInfo.name} (EPSG:${epsg})` };
          }
        }

        // 2. EPSG:3857 (Web Mercator)
        if (epsg === 3857 || epsg === 900913) {
          const bounds = L.latLngBounds(
            this._merc2latlon(minX, minY),
            this._merc2latlon(maxX, maxY)
          );
          return { bounds, crsName: `Web Mercator (EPSG:${epsg})` };
        }

        // 3. EPSG:4326 (WGS84) または経緯度数値範囲内 (-180 <= X <= 180, -90 <= Y <= 90)
        if (minX >= -180 && maxX <= 180 && minY >= -90 && maxY <= 90) {
          const bounds = L.latLngBounds([minY, minX], [maxY, maxX]);
          return { bounds, crsName: epsg ? `WGS 84 (EPSG:${epsg})` : 'WGS 84 緯度経度' };
        }

        // 4. 平面座標系（メートル系）で EPSG コード未定義の場合の自動推定
        if (Math.abs(minX) > 180 || Math.abs(maxX) > 180 || Math.abs(minY) > 90 || Math.abs(maxY) > 90) {
          await this._ensureProj4();

          const estimatedZone = this._estimateJgdZone(minX, minY, maxX, maxY);
          if (estimatedZone) {
            const epsgEst = 6668 + estimatedZone;
            const projInfo = this._registerJgdPlaneZone(epsgEst);
            if (projInfo) {
              const bounds = this._convertPlaneBboxToBounds(minX, minY, maxX, maxY, projInfo.epsgStr);
              return { bounds, crsName: `${projInfo.name} (自動推定 EPSG:${epsgEst})` };
            }
          }

          // フォールバック: Web Mercator として変換を試みる
          const sw = this._merc2latlon(minX, minY);
          const ne = this._merc2latlon(maxX, maxY);
          if (sw[0] >= -90 && sw[0] <= 90 && ne[0] >= -90 && ne[0] <= 90) {
            return { bounds: L.latLngBounds(sw, ne), crsName: 'Web Mercator (推定)' };
          }
        }

        return null;
      } catch (e) {
        console.error('[GeoTiffHandler] Bounds extraction error:', e);
        return null;
      }
    },

    /**
     * 日本の平面直交系 EPSG コードを Proj4 に登録する
     * @param {number} epsg
     * @returns {{zone: number, name: string, epsgStr: string}|null}
     */
    _registerJgdPlaneZone(epsg) {
      if (!window.proj4) return null;
      let zone = null;
      let name = '';
      if (epsg >= 6669 && epsg <= 6687) {
        zone = epsg - 6668;
        name = `JGD2011 平面直交第${zone}系`;
      } else if (epsg >= 2443 && epsg <= 2461) {
        zone = epsg - 2442;
        name = `JGD2000 平面直交第${zone}系`;
      }
      if (!zone || !JGD_PLANE_ZONES[zone]) return null;

      const info = JGD_PLANE_ZONES[zone];
      const epsgStr = `EPSG:${epsg}`;
      if (!window.proj4.defs[epsgStr]) {
        const proj4Def = `+proj=tmerc +lat_0=${info.lat} +lon_0=${info.lon} +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs`;
        window.proj4.defs(epsgStr, proj4Def);
      }
      return { zone, name, epsgStr };
    },

    /**
     * 平面直交系の 4 角バウンディングボックスを WGS84 緯度経度に変換して LatLngBounds を作成
     */
    _convertPlaneBboxToBounds(minX, minY, maxX, maxY, epsgStr) {
      const corners = [
        [minX, minY],
        [minX, maxY],
        [maxX, minY],
        [maxX, maxY]
      ];

      let minLat = Infinity, maxLat = -Infinity;
      let minLon = Infinity, maxLon = -Infinity;

      for (const [x, y] of corners) {
        const [lon, lat] = window.proj4(epsgStr, 'EPSG:4326', [x, y]);
        if (isFinite(lat) && isFinite(lon)) {
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
        }
      }

      return L.latLngBounds([minLat, minLon], [maxLat, maxLon]);
    },

    /**
     * 座標値 (X, Y) から最も適した日本の平面直交系 (1〜19) を自動推定する
     */
    _estimateJgdZone(minX, minY, maxX, maxY) {
      const midX = (minX + maxX) / 2;
      const midY = (minY + maxY) / 2;

      // 距離が極端に大きい場合は対象外
      if (Math.abs(midX) > 600000 || Math.abs(midY) > 600000) return null;

      let bestZone = null;
      let minDistance = Infinity;

      for (let zone = 1; zone <= 19; zone++) {
        // 各系の原点からの平面座標上の距離の近似（原点[0,0]からの距離）
        const dist = Math.sqrt(midX * midX + midY * midY);
        if (dist < minDistance) {
          minDistance = dist;
          bestZone = zone;
        }
      }

      return bestZone;
    },

    /**
     * Web Mercator (EPSG:3857) → WGS84 (EPSG:4326) 変換
     */
    _merc2latlon(x, y) {
      const lon = (x * 180) / 20037508.342789244;
      const lat = (Math.atan(Math.exp((y * Math.PI) / 20037508.342789244)) * 360) / Math.PI - 90;
      return [lat, lon];
    },

    // ------------------------------------------------------------------
    // ラスタ → Canvas 変換
    // ------------------------------------------------------------------

    /**
     * GeoTIFFラスタをCanvasに描画してDataURLを返す（判別スタイルまたは指定パレット適用）
     *
     * readRasters({ width: outW, height: outH }) で geotiff.js に内部リサンプルを任せる。
     * これにより元解像度の巨大 ImageData を作成するステップが不要になる。
     *
     * @param {GeoTIFF.GeoTIFFImage} image
     * @param {number} outW   - 出力幅（ピクセル）
     * @param {number} outH   - 出力高（ピクセル）
     * @param {object} [detectedType] - 判別されたラスタ種別
     * @param {Function} onProgress - (percent: number, message: string) => void
     * @returns {Promise<string>} DataURL (PNG)
     */
    async _rasterToCanvas(image, outW, outH, detectedType = { paletteName: 'turbo' }, onProgress = () => {}) {
      const samplesPerPixel = image.getSamplesPerPixel();
      const noData = image.noDataValue;

      // 出力解像度で直接読み込む（ここがメモリ節約の核心）
      onProgress(50, `ラスタをデコード中 (${outW}×${outH}px)...`);
      await this._yield();

      const data = await image.readRasters({
        interleave: true,
        width:  outW,
        height: outH
      });

      // Canvas 初期化（出力サイズのみ確保）
      const canvas  = document.createElement('canvas');
      canvas.width  = outW;
      canvas.height = outH;
      const ctx     = canvas.getContext('2d');
      const imgData = ctx.createImageData(outW, outH);
      const buf     = imgData.data;

      // チャンク単位で処理する行数
      const ROWS_PER_CHUNK = Math.max(1, Math.ceil(50000 / outW));

      let minVal = Infinity, maxVal = -Infinity;

      if (detectedType.paletteName === 'photo' && samplesPerPixel >= 3) {
        // マルチバンドカラー写真（RGB / RGBA）
        for (let row = 0; row < outH; row += ROWS_PER_CHUNK) {
          const rowEnd = Math.min(row + ROWS_PER_CHUNK, outH);
          for (let r = row; r < rowEnd; r++) {
            for (let c = 0; c < outW; c++) {
              const i = r * outW + c;
              const rVal = data[i * samplesPerPixel];
              const gVal = data[i * samplesPerPixel + 1];
              const bVal = data[i * samplesPerPixel + 2];
              const isNoData = (noData !== undefined && rVal === noData);

              buf[i * 4]     = rVal;
              buf[i * 4 + 1] = gVal;
              buf[i * 4 + 2] = bVal;
              buf[i * 4 + 3] = isNoData ? 0 : (samplesPerPixel >= 4 ? data[i * samplesPerPixel + 3] : 255);
            }
          }
          const pct = 58 + Math.round((rowEnd / outH) * 35);
          onProgress(pct, `描画中... ${Math.round((rowEnd / outH) * 100)}% (${rowEnd.toLocaleString()} / ${outH.toLocaleString()} 行)`);
          await this._yield();
        }
        minVal = 0;
        maxVal = 255;
      } else if (detectedType.paletteName === 'palette' && detectedType.colorMap) {
        // パレットカラー画像（ColorMapテーブル参照）
        const cm = detectedType.colorMap;
        const numColors = Math.floor(cm.length / 3);
        for (let row = 0; row < outH; row += ROWS_PER_CHUNK) {
          const rowEnd = Math.min(row + ROWS_PER_CHUNK, outH);
          for (let r = row; r < rowEnd; r++) {
            for (let c = 0; c < outW; c++) {
              const i = r * outW + c;
              const idx = data[i];
              const isNoData = (noData !== undefined && idx === noData);

              buf[i * 4]     = (cm[idx] >> 8) & 255;
              buf[i * 4 + 1] = (cm[numColors + idx] >> 8) & 255;
              buf[i * 4 + 2] = (cm[2 * numColors + idx] >> 8) & 255;
              buf[i * 4 + 3] = isNoData ? 0 : 255;
            }
          }
          const pct = 58 + Math.round((rowEnd / outH) * 35);
          onProgress(pct, `描画中... ${Math.round((rowEnd / outH) * 100)}%`);
          await this._yield();
        }
        minVal = 0;
        maxVal = numColors - 1;
      } else {
        // 単一バンドラスタ: CS立体図 / TWI / 標高 / 傾斜 / Turbo / グレースケール
        onProgress(54, 'ピクセル値範囲を走査中...');
        await this._yield();

        // 最小値・最大値のスキャン
        for (let i = 0; i < data.length; i++) {
          const v = data[i];
          if (isFinite(v) && (noData === undefined || v !== noData)) {
            if (v < minVal) minVal = v;
            if (v > maxVal) maxVal = v;
          }
        }

        if (minVal === Infinity || maxVal === -Infinity) {
          minVal = 0;
          maxVal = 255;
        } else if (minVal === maxVal) {
          maxVal = minVal + 1;
        }

        const span = maxVal - minVal;
        const lut = getColorLut(detectedType.paletteName || 'turbo');

        for (let row = 0; row < outH; row += ROWS_PER_CHUNK) {
          const rowEnd = Math.min(row + ROWS_PER_CHUNK, outH);
          for (let r = row; r < rowEnd; r++) {
            for (let c = 0; c < outW; c++) {
              const i = r * outW + c;
              const v = data[i];
              const isNoData = (noData !== undefined && v === noData) || !isFinite(v);

              if (isNoData) {
                buf[i * 4 + 3] = 0; // 完全透明
              } else {
                const norm = Math.max(0, Math.min(1, (v - minVal) / span));
                const lutIdx = Math.floor(norm * 255) * 4;
                buf[i * 4]     = lut[lutIdx];
                buf[i * 4 + 1] = lut[lutIdx + 1];
                buf[i * 4 + 2] = lut[lutIdx + 2];
                buf[i * 4 + 3] = 255;
              }
            }
          }

          const pct = 58 + Math.round((rowEnd / outH) * 35);
          onProgress(pct, `描画中... ${Math.round((rowEnd / outH) * 100)}% (${rowEnd.toLocaleString()} / ${outH.toLocaleString()} 行)`);
          await this._yield();
        }
      }

      ctx.putImageData(imgData, 0, 0);
      onProgress(95, '画像をエンコード中...');
      await this._yield();

      const dataUrl = canvas.toDataURL('image/png');
      return {
        dataUrl,
        rasterData: data,
        minVal: (minVal !== Infinity) ? minVal : 0,
        maxVal: (maxVal !== -Infinity) ? maxVal : 255,
        noData: noData,
        outW: outW,
        outH: outH,
        samplesPerPixel: samplesPerPixel
      };
    },

    // ------------------------------------------------------------------
    // ユーティリティ
    // ------------------------------------------------------------------

    /**
     * UIスレッドをブロックしないように制御を返す
     * @returns {Promise<void>}
     */
    _yield() {
      return new Promise(resolve => setTimeout(resolve, 0));
    },

    /**
     * geotiff.js ライブラリを動的に読み込む
     * @returns {Promise<void>}
     */
    _ensureGeotiff() {
      if (geotiffReady) return Promise.resolve();
      if (geotiffLoading) {
        return new Promise((resolve, reject) => geotiffCallbacks.push({ resolve, reject }));
      }

      geotiffLoading = true;
      return new Promise((resolve, reject) => {
        geotiffCallbacks.push({ resolve, reject });
        const script = document.createElement('script');
        script.src = GEOTIFF_CDN;
        script.onload = () => {
          geotiffReady    = true;
          geotiffLoading  = false;
          geotiffCallbacks.forEach(cb => cb.resolve());
          geotiffCallbacks = [];
        };
        script.onerror = () => {
          geotiffLoading = false;
          const err = new Error('GeoTIFFライブラリの読み込みに失敗しました。');
          geotiffCallbacks.forEach(cb => cb.reject(err));
          geotiffCallbacks = [];
          reject(err);
        };
        document.head.appendChild(script);
      });
    },

    /**
     * proj4.js ライブラリを動的に読み込む
     * @returns {Promise<void>}
     */
    _ensureProj4() {
      if (proj4Ready) return Promise.resolve();
      if (proj4Loading) {
        return new Promise((resolve, reject) => proj4Callbacks.push({ resolve, reject }));
      }

      proj4Loading = true;
      return new Promise((resolve, reject) => {
        proj4Callbacks.push({ resolve, reject });
        const script = document.createElement('script');
        script.src = PROJ4_CDN;
        script.onload = () => {
          proj4Ready    = true;
          proj4Loading  = false;
          proj4Callbacks.forEach(cb => cb.resolve());
          proj4Callbacks = [];
        };
        script.onerror = () => {
          proj4Loading = false;
          const err = new Error('Proj4ライブラリの読み込みに失敗しました。');
          proj4Callbacks.forEach(cb => cb.reject(err));
          proj4Callbacks = [];
          reject(err);
        };
        document.head.appendChild(script);
      });
    }
  };

})(window.GIS = window.GIS || {});
