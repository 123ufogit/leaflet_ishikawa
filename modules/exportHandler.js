/**
 * exportHandler.js - GeoJSON / KML / PDF（html2canvas+jsPDF）エクスポート
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  /** html2canvas CDN */
  const HTML2CANVAS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
  /** jsPDF CDN */
  const JSPDF_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';

  let exportLibsReady = false;
  let exportLibsLoading = false;
  let exportCallbacks = [];

  GIS.ExportHandler = {
    currentFormat: 'geojson',

    init() {
      const saved = localStorage.getItem('gis_export_format');
      if (saved && ['geojson', 'kml', 'pdf', 'png'].includes(saved)) {
        this.currentFormat = saved;
      }
      this.updateUIBadge();
      this._bindSettingsEvents();
    },

    setFormat(fmt) {
      if (!['geojson', 'kml', 'pdf', 'png'].includes(fmt)) return;
      this.currentFormat = fmt;
      localStorage.setItem('gis_export_format', fmt);
      this.updateUIBadge();
      const radios = document.querySelectorAll('input[name="export-format-radio"]');
      radios.forEach(r => {
        r.checked = (r.value === fmt);
      });
      if (GIS.UI && GIS.UI.showToast) {
        const labels = { geojson: 'GeoJSON', kml: 'KML', pdf: 'PDF', png: 'PNG' };
        GIS.UI.showToast(`⚙️ エクスポート形式を「${labels[fmt]}」に設定しました`, 'info');
      }
    },

    updateUIBadge() {
      const badge = document.getElementById('unified-export-badge');
      const labels = { geojson: 'GeoJSON', kml: 'KML', pdf: 'PDF', png: 'PNG' };
      const currentFmt = this.currentFormat || 'geojson';

      if (badge) {
        if (currentFmt === 'geojson' || currentFmt === 'kml') {
          const selectedId = GIS.AppState ? GIS.AppState.selectedLayerId : null;
          const selectedEntry = selectedId && GIS.AppState.layers ? GIS.AppState.layers.get(selectedId) : null;
          if (selectedEntry) {
            badge.textContent = `${labels[currentFmt]}: ${selectedEntry.name}`;
          } else {
            badge.textContent = `${labels[currentFmt]} (レイヤ未選択)`;
          }
        } else {
          badge.textContent = labels[currentFmt] || 'GeoJSON';
        }
      }
      const radios = document.querySelectorAll('input[name="export-format-radio"]');
      radios.forEach(r => {
        if (r.value === currentFmt) r.checked = true;
      });
    },

    _bindSettingsEvents() {
      const radios = document.querySelectorAll('input[name="export-format-radio"]');
      radios.forEach(r => {
        r.addEventListener('change', (e) => {
          if (e.target.checked) {
            this.setFormat(e.target.value);
          }
        });
      });
    },

    /**
     * 統合エクスポートボタン押下時に、設定された形式で確認なし自動ダウンロード
     */
    executeUnifiedExport() {
      const fmt = this.currentFormat || 'geojson';
      if (fmt === 'geojson') {
        this.exportGeoJSON();
      } else if (fmt === 'kml') {
        this.exportKML();
      } else if (fmt === 'pdf') {
        this.exportDirectPDF();
      } else if (fmt === 'png') {
        this.exportDirectPNG();
      }
    },

    /**
     * 単一レイヤーエントリから Feature 一覧を抽出
     */
    _getFeaturesForEntry(entry) {
      const features = [];
      if (!entry) return features;

      let geojson = entry.rawGeoJSON;
      if (!geojson && entry.layer && typeof entry.layer.toGeoJSON === 'function') {
        try { geojson = entry.layer.toGeoJSON(); } catch (_) {}
      }

      if (!geojson) return features;

      if (geojson.type === 'FeatureCollection' && Array.isArray(geojson.features)) {
        geojson.features.forEach(f => {
          const copy = JSON.parse(JSON.stringify(f));
          if (!copy.properties) copy.properties = {};
          if (!copy.properties.name) copy.properties.name = entry.name;
          features.push(copy);
        });
      } else if (geojson.type === 'Feature') {
        const copy = JSON.parse(JSON.stringify(geojson));
        if (!copy.properties) copy.properties = {};
        if (!copy.properties.name) copy.properties.name = entry.name;
        features.push(copy);
      } else if (geojson.type && geojson.coordinates) {
        features.push({
          type: 'Feature',
          geometry: geojson,
          properties: { name: entry.name }
        });
      }
      return features;
    },

    /**
     * 選択された対象レイヤーをGeoJSON形式でダウンロードする（選択時のみ有効）
     */
    exportGeoJSON() {
      const selectedId = GIS.AppState ? GIS.AppState.selectedLayerId : null;
      if (!selectedId) {
        GIS.UI.showToast('⚠️ エクスポートする対象レイヤーをレイヤーリストから選択してください', 'warn');
        if (GIS.FloatingPanel) {
          GIS.FloatingPanel.expand();
        }
        return;
      }

      const entry = GIS.AppState.layers.get(selectedId);
      if (!entry) {
        GIS.AppState.selectedLayerId = null;
        this.updateUIBadge();
        GIS.UI.showToast('⚠️ 選択されたレイヤーが見つかりません。リストから再選択してください', 'warn');
        return;
      }

      const vectorFeatures = this._getFeaturesForEntry(entry);
      // 写真ピンレイヤーの場合
      const isPinLayer = entry.type === 'pin' || entry.name.includes('写真') || entry.name.includes('ピン');
      let pinFeatures = [];
      if (isPinLayer && GIS.AppState.pins && GIS.AppState.pins.length) {
        pinFeatures = GIS.AppState.pins.map(pin => ({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [pin.latlng.lng, pin.latlng.lat]
          },
          properties: {
            name: pin.filename,
            filename: pin.filename,
            is360: pin.is360,
            timestamp: new Date().toISOString()
          }
        }));
      }

      const allFeatures = [...pinFeatures, ...vectorFeatures];
      if (!allFeatures.length) {
        GIS.UI.showToast(`⚠️ レイヤー『${entry.name}』にはエクスポート可能なベクターデータがありません`, 'warn');
        return;
      }

      const geojson = {
        type: 'FeatureCollection',
        features: allFeatures,
        metadata: {
          layerName: entry.name,
          created: new Date().toISOString(),
          generator: 'GIS Browser - Leaflet WebGIS',
          count: allFeatures.length
        }
      };

      const json = JSON.stringify(geojson, null, 2);
      const filename = `${entry.name}.geojson`;

      this._download(
        new Blob([json], { type: 'application/geo+json' }),
        filename
      );

      GIS.UI.showToast(`✅ 『${entry.name}』(${allFeatures.length}件) をGeoJSON形式で保存しました`, 'success');
    },

    /**
     * 選択された対象レイヤーをKML形式でダウンロードする（選択時のみ有効）
     */
    exportKML() {
      const selectedId = GIS.AppState ? GIS.AppState.selectedLayerId : null;
      if (!selectedId) {
        GIS.UI.showToast('⚠️ エクスポートする対象レイヤーをレイヤーリストから選択してください', 'warn');
        if (GIS.FloatingPanel) {
          GIS.FloatingPanel.expand();
        }
        return;
      }

      const entry = GIS.AppState.layers.get(selectedId);
      if (!entry) {
        GIS.AppState.selectedLayerId = null;
        this.updateUIBadge();
        GIS.UI.showToast('⚠️ 選択されたレイヤーが見つかりません。リストから再選択してください', 'warn');
        return;
      }

      const vectorFeatures = this._getFeaturesForEntry(entry);
      const isPinLayer = entry.type === 'pin' || entry.name.includes('写真') || entry.name.includes('ピン');
      let pins = [];
      if (isPinLayer && GIS.AppState.pins && GIS.AppState.pins.length) {
        pins = GIS.AppState.pins;
      }

      if (!pins.length && !vectorFeatures.length) {
        GIS.UI.showToast(`⚠️ レイヤー『${entry.name}』にはエクスポート可能なデータがありません`, 'warn');
        return;
      }

      const pinPlacemarks = pins.map(pin => `
    <Placemark>
      <name>${this._escXml(pin.filename)}</name>
      <description><![CDATA[
        ファイル名: ${this._escXml(pin.filename)}<br>
        ${pin.is360 ? '360°全天球画像<br>' : ''}
        緯度: ${pin.latlng.lat.toFixed(8)}<br>
        経度: ${pin.latlng.lng.toFixed(8)}
      ]]></description>
      <Style>
        <IconStyle>
          <color>ff${pin.is360 ? '356bff' : 'ffd400'}</color>
          <scale>1.0</scale>
          <Icon>
            <href>https://maps.google.com/mapfiles/kml/pushpin/ylw-pushpin.png</href>
          </Icon>
        </IconStyle>
      </Style>
      <Point>
        <coordinates>${pin.latlng.lng.toFixed(8)},${pin.latlng.lat.toFixed(8)},0</coordinates>
      </Point>
    </Placemark>`).join('\n');

      const vectorPlacemarks = vectorFeatures.map((f, i) => {
        const name = this._escXml(f.properties?.name || `${entry.name} ${i + 1}`);
        const geom = f.geometry;
        if (!geom) return '';

        let kmlGeom = '';
        if (geom.type === 'Polygon') {
          const outerRing = geom.coordinates[0] || [];
          const coordsStr = outerRing.map(pt => `${pt[0]},${pt[1]},0`).join(' ');
          kmlGeom = `
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>${coordsStr}</coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>`;
        } else if (geom.type === 'MultiPolygon') {
          const polys = geom.coordinates.map(poly => {
            const outerRing = poly[0] || [];
            const coordsStr = outerRing.map(pt => `${pt[0]},${pt[1]},0`).join(' ');
            return `
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>${coordsStr}</coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>`;
          }).join('\n');
          kmlGeom = `<MultiGeometry>${polys}</MultiGeometry>`;
        } else if (geom.type === 'LineString') {
          const coordsStr = geom.coordinates.map(pt => `${pt[0]},${pt[1]},0`).join(' ');
          kmlGeom = `<LineString><coordinates>${coordsStr}</coordinates></LineString>`;
        } else if (geom.type === 'Point') {
          kmlGeom = `<Point><coordinates>${geom.coordinates[0]},${geom.coordinates[1]},0</coordinates></Point>`;
        }

        return `
    <Placemark>
      <name>${name}</name>
      <Style>
        <LineStyle><color>ff00d7ff</color><width>2</width></LineStyle>
        <PolyStyle><color>7f00d7ff</color></PolyStyle>
      </Style>
      ${kmlGeom}
    </Placemark>`;
      }).filter(Boolean).join('\n');

      const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${this._escXml(entry.name)}</name>
    <description>エクスポート元: ${this._escXml(entry.name)} (生成日時: ${new Date().toLocaleString('ja-JP')})</description>
    ${pinPlacemarks}
    ${vectorPlacemarks}
  </Document>
</kml>`;

      const filename = `${entry.name}_${this._timestamp()}.kml`;

      this._download(
        new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' }),
        filename
      );

      GIS.UI.showToast(`✅ 『${entry.name}』(${vectorFeatures.length + pins.length}件) をKML形式で保存しました`, 'success');
    },

    /**
     * 地図をPDF（A4横）またはPNG画像で出力する
     * html2canvas + jsPDF を動的ロードして使用
     */
    async exportPDF() {
      GIS.UI.showToast('🖨️ PDF出力の準備中...', 'info');

      try {
        await this._ensureExportLibs();
      } catch (e) {
        GIS.UI.showToast('❌ PDF出力ライブラリの読み込みに失敗しました', 'error');
        return;
      }

      // フローティングパネルとUIを一時非表示
      GIS.FloatingPanel.setVisible(false);
      const overlay = document.getElementById('location-mode-overlay');
      const preview = document.getElementById('photo-preview-panel');
      const toast   = document.getElementById('toast');
      overlay.classList.add('hidden');
      preview.classList.add('hidden');
      toast.classList.add('hidden');

      // 地図コンテナを取得
      const mapEl = document.getElementById('map');

      try {
        // Leafletタイルを確実に表示するため少し待つ
        await new Promise(r => setTimeout(r, 500));

        const canvas = await this._captureMapCanvas(mapEl);

        // PDF出力ダイアログ
        const format = await this._askExportFormat();

        if (format === 'png') {
          // PNG として保存
          canvas.toBlob(blob => {
            this._download(blob, `gis_map_${this._timestamp()}.png`);
            GIS.UI.showToast('✅ PNG画像を保存しました', 'success');
          }, 'image/png');

        } else {
          // PDF（A4横）として保存
          const { jsPDF } = window.jspdf;
          const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

          const pdfW = pdf.internal.pageSize.getWidth();
          const pdfH = pdf.internal.pageSize.getHeight();
          const imgW = canvas.width;
          const imgH = canvas.height;
          const ratio = Math.min(pdfW / imgW, pdfH / imgH);
          const w = imgW * ratio;
          const h = imgH * ratio;
          const x = (pdfW - w) / 2;
          const y = (pdfH - h) / 2;

          const imgData = canvas.toDataURL('image/jpeg', 0.92);
          pdf.addImage(imgData, 'JPEG', x, y, w, h);
          pdf.save(`gis_map_${this._timestamp()}.pdf`);
          GIS.UI.showToast('✅ PDFを保存しました', 'success');
        }

      } catch (err) {
        console.error('[ExportHandler] PDF export error:', err);
        GIS.UI.showToast(`❌ 出力エラー: ${err.message}`, 'error');
      } finally {
        // UIを元に戻す
        GIS.FloatingPanel.setVisible(true);
      }
    },

    /**
     * 確認ダイアログなしで直接PDFを自動ダウンロードする
     */
    async exportDirectPDF() {
      GIS.UI.showToast('🖨️ PDF出力の準備中...', 'info');

      try {
        await this._ensureExportLibs();
      } catch (e) {
        GIS.UI.showToast('❌ PDF出力ライブラリの読み込みに失敗しました', 'error');
        return;
      }

      GIS.FloatingPanel.setVisible(false);
      const overlay = document.getElementById('location-mode-overlay');
      const preview = document.getElementById('photo-preview-panel');
      const toast   = document.getElementById('toast');
      if (overlay) overlay.classList.add('hidden');
      if (preview) preview.classList.add('hidden');
      if (toast) toast.classList.add('hidden');

      const mapEl = document.getElementById('map');

      try {
        await new Promise(r => setTimeout(r, 500));

        const canvas = await this._captureMapCanvas(mapEl);

        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

        const pdfW = pdf.internal.pageSize.getWidth();
        const pdfH = pdf.internal.pageSize.getHeight();
        const imgW = canvas.width;
        const imgH = canvas.height;
        const ratio = Math.min(pdfW / imgW, pdfH / imgH);
        const w = imgW * ratio;
        const h = imgH * ratio;
        const x = (pdfW - w) / 2;
        const y = (pdfH - h) / 2;

        const imgData = canvas.toDataURL('image/jpeg', 0.92);
        pdf.addImage(imgData, 'JPEG', x, y, w, h);
        pdf.save(`gis_map_${this._timestamp()}.pdf`);
        GIS.UI.showToast('✅ PDFを自動保存しました', 'success');

      } catch (err) {
        console.error('[ExportHandler] PDF export error:', err);
        GIS.UI.showToast(`❌ 出力エラー: ${err.message}`, 'error');
      } finally {
        GIS.FloatingPanel.setVisible(true);
      }
    },

    /**
     * 確認ダイアログなしで直接PNG画像を自動ダウンロードする
     */
    async exportDirectPNG() {
      GIS.UI.showToast('🖼️ PNG画像出力の準備中...', 'info');

      try {
        await this._ensureExportLibs();
      } catch (e) {
        GIS.UI.showToast('❌ 画像出力ライブラリの読み込みに失敗しました', 'error');
        return;
      }

      GIS.FloatingPanel.setVisible(false);
      const overlay = document.getElementById('location-mode-overlay');
      const preview = document.getElementById('photo-preview-panel');
      const toast   = document.getElementById('toast');
      if (overlay) overlay.classList.add('hidden');
      if (preview) preview.classList.add('hidden');
      if (toast) toast.classList.add('hidden');

      const mapEl = document.getElementById('map');

      try {
        await new Promise(r => setTimeout(r, 500));

        const canvas = await this._captureMapCanvas(mapEl);

        canvas.toBlob(blob => {
          this._download(blob, `gis_map_${this._timestamp()}.png`);
          GIS.UI.showToast('✅ PNG画像を自動保存しました', 'success');
        }, 'image/png');

      } catch (err) {
        console.error('[ExportHandler] PNG export error:', err);
        GIS.UI.showToast(`❌ 出力エラー: ${err.message}`, 'error');
      } finally {
        GIS.FloatingPanel.setVisible(true);
      }
    },

    /**
     * html2canvas で地図要素をキャプチャし、各ペインのSVGベクターレイヤー（県営林・小班・林道・作図等）を合成したCanvasを生成する
     * @param {HTMLElement} mapEl
     * @returns {Promise<HTMLCanvasElement>}
     */
    async _captureMapCanvas(mapEl) {
      // 進行中のズーム・パンアニメーションを停止し静止状態を保証
      if (GIS.AppState && GIS.AppState.map && typeof GIS.AppState.map.stop === 'function') {
        GIS.AppState.map.stop();
      }

      const scale = window.devicePixelRatio || 1;

      // 1. html2canvas でベース地図（タイル・画像・マーカー・ラベル等）をキャプチャ
      // ★重要: Leafletの .leaflet-map-pane はパン操作時に CSS transform: translate3d(...) で移動管理されており、
      // html2canvas がこれを誤って解釈して背景地図とベクターがずれるため、onclone 内で transform を解除し
      // 同値の left / top に変換して正確にレンダリングさせる。
      const canvas = await window.html2canvas(mapEl, {
        useCORS:         true,
        allowTaint:      true,
        scale:           scale,
        logging:         false,
        foreignObjectRendering: false,
        width:           mapEl.clientWidth,
        height:          mapEl.clientHeight,
        x:               0,
        y:               0,
        scrollX:         0,
        scrollY:         0,
        windowWidth:     mapEl.clientWidth,
        windowHeight:    mapEl.clientHeight,
        ignoreElements:  (element) => {
          // SVGおよびCanvasベクターレイヤー（Leafletオーバーレイ）は下段で手動高精度合成するためスキップ
          const tag = element.tagName ? element.tagName.toLowerCase() : '';
          if (tag === 'svg') return true;
          if (tag === 'canvas' && (element.classList.contains('leaflet-zoom-animated') || element.closest('.leaflet-overlay-pane'))) {
            return true;
          }
          return false;
        },
        onclone: (clonedDoc) => {
          // タイルコンテナのアニメーション/トランジションを無効化して静止画像を確実に取得
          const tileContainers = clonedDoc.querySelectorAll('.leaflet-tile-container');
          tileContainers.forEach(tc => {
            tc.style.animation = 'none';
            tc.style.transition = 'none';
          });
        }
      });

      const ctx = canvas.getContext('2d');
      if (!ctx) return canvas;

      const mapRect = mapEl.getBoundingClientRect();

      // 2. 地図コンテナ内のすべてのベクター要素（SVGおよびCanvas）を収集
      const svgElements = Array.from(mapEl.querySelectorAll('.leaflet-pane svg, #map > svg, svg.leaflet-zoom-animated'));
      const uniqueSvgs = Array.from(new Set(svgElements)).filter(svg => {
        if (!svg || svg.style.display === 'none') return false;
        return svg.querySelector('path, polygon, polyline, circle, rect, line');
      });

      const rawCanvases = Array.from(mapEl.querySelectorAll('.leaflet-overlay-pane canvas, .leaflet-pane canvas.leaflet-zoom-animated, .leaflet-pane canvas'));
      const vectorCanvases = Array.from(new Set(rawCanvases)).filter(c => {
        if (!c || c.style.display === 'none') return false;
        if (c.width === 0 || c.height === 0) return false;
        return true;
      });

      // SVGとCanvasを合体し、表示順（paneのz-indexおよびDOM順）にソート
      const allVectors = [...uniqueSvgs, ...vectorCanvases];
      const getPaneZIndex = (el) => {
        const pane = el.closest('.leaflet-pane');
        return pane ? parseInt(window.getComputedStyle(pane).zIndex || '0', 10) : 0;
      };

      allVectors.sort((a, b) => {
        const zA = getPaneZIndex(a);
        const zB = getPaneZIndex(b);
        if (zA !== zB) return zA - zB;
        return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
      });

      // 3. 各ベクター要素を順次Canvasに描画
      for (const el of allVectors) {
        try {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;

          const dx = (rect.left - mapRect.left) * scale;
          const dy = (rect.top - mapRect.top) * scale;
          const dWidth = rect.width * scale;
          const dHeight = rect.height * scale;

          const tag = el.tagName ? el.tagName.toLowerCase() : '';

          if (tag === 'canvas') {
            // HTML5 Canvas 要素（FlatGeobuf 等の L.canvas() レイヤー）の合成
            const savedAlpha = ctx.globalAlpha;
            const compOpacity = parseFloat(window.getComputedStyle(el).opacity);
            if (!isNaN(compOpacity) && compOpacity >= 0 && compOpacity <= 1) {
              ctx.globalAlpha = compOpacity;
            }
            ctx.drawImage(el, dx, dy, dWidth, dHeight);
            ctx.globalAlpha = savedAlpha;

          } else if (tag === 'svg') {
            // SVG要素（GeoJSON, 作図等）の合成
            const clone = el.cloneNode(true);
            clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

            const origW = el.getAttribute('width') || el.clientWidth || rect.width;
            const origH = el.getAttribute('height') || el.clientHeight || rect.height;
            clone.setAttribute('width', origW);
            clone.setAttribute('height', origH);

            if (!clone.getAttribute('viewBox')) {
              clone.setAttribute('viewBox', `0 0 ${origW} ${origH}`);
            }

            clone.style.transform = 'none';
            clone.style.webkitTransform = 'none';
            clone.style.position = 'static';
            clone.style.margin = '0';
            clone.style.padding = '0';

            const origPaths = el.querySelectorAll('path, polygon, polyline, circle, rect, line');
            const clonePaths = clone.querySelectorAll('path, polygon, polyline, circle, rect, line');
            origPaths.forEach((origEl, i) => {
              const targetEl = clonePaths[i];
              if (!targetEl) return;
              const cs = window.getComputedStyle(origEl);
              if (!targetEl.getAttribute('fill') && cs.fill) targetEl.setAttribute('fill', cs.fill);
              if (!targetEl.getAttribute('stroke') && cs.stroke) targetEl.setAttribute('stroke', cs.stroke);
              if (!targetEl.getAttribute('stroke-width') && cs.strokeWidth) targetEl.setAttribute('stroke-width', cs.strokeWidth);
              if (!targetEl.getAttribute('stroke-opacity') && cs.strokeOpacity) targetEl.setAttribute('stroke-opacity', cs.strokeOpacity);
              if (!targetEl.getAttribute('fill-opacity') && cs.fillOpacity) targetEl.setAttribute('fill-opacity', cs.fillOpacity);
            });

            const xml = new XMLSerializer().serializeToString(clone);
            const svgBlob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
            const blobUrl = URL.createObjectURL(svgBlob);

            await new Promise((resolve) => {
              const img = new Image();
              img.onload = () => {
                ctx.drawImage(img, dx, dy, dWidth, dHeight);
                URL.revokeObjectURL(blobUrl);
                resolve();
              };
              img.onerror = () => {
                URL.revokeObjectURL(blobUrl);
                resolve();
              };
              img.src = blobUrl;
            });
          }
        } catch (e) {
          console.warn('[ExportHandler] Vector overlay composite error:', e);
        }
      }

      return canvas;
    },

    /**
     * 出力形式（PDF / PNG）を選択するダイアログを表示する
     * @returns {Promise<'pdf'|'png'>}
     */
    _askExportFormat() {
      return new Promise(resolve => {
        const modal = document.getElementById('export-format-modal');
        modal.classList.remove('hidden');

        const onPdf = () => { cleanup(); resolve('pdf'); };
        const onPng = () => { cleanup(); resolve('png'); };
        const cleanup = () => {
          modal.classList.add('hidden');
          document.getElementById('export-format-pdf').removeEventListener('click', onPdf);
          document.getElementById('export-format-png').removeEventListener('click', onPng);
        };

        document.getElementById('export-format-pdf').addEventListener('click', onPdf);
        document.getElementById('export-format-png').addEventListener('click', onPng);
      });
    },

    /**
     * Blobをダウンロードする
     * @param {Blob} blob
     * @param {string} filename
     */
    _download(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    },

    /**
     * タイムスタンプ文字列を生成する (YYYYMMDD_HHmmss)
     * @returns {string}
     */
    _timestamp() {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    },

    /**
     * XML特殊文字をエスケープする
     * @param {string} str
     * @returns {string}
     */
    _escXml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    },

    /**
     * html2canvas と jsPDF を動的に読み込む（初回のみ）
     * @returns {Promise<void>}
     */
    _ensureExportLibs() {
      if (exportLibsReady) return Promise.resolve();
      if (exportLibsLoading) {
        return new Promise((resolve, reject) => exportCallbacks.push({ resolve, reject }));
      }

      exportLibsLoading = true;
      return new Promise((resolve, reject) => {
        exportCallbacks.push({ resolve, reject });

        const loadScript = (src) => new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = src;
          s.onload = res;
          s.onerror = () => rej(new Error(`Failed to load: ${src}`));
          document.head.appendChild(s);
        });

        loadScript(HTML2CANVAS_CDN)
          .then(() => loadScript(JSPDF_CDN))
          .then(() => {
            exportLibsReady = true;
            exportLibsLoading = false;
            exportCallbacks.forEach(cb => cb.resolve());
            exportCallbacks = [];
          })
          .catch(err => {
            exportLibsLoading = false;
            exportCallbacks.forEach(cb => cb.reject(err));
            exportCallbacks = [];
            reject(err);
          });
      });
    }
  };

})(window.GIS = window.GIS || {});
