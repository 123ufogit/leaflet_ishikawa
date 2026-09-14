/**
 * shohanStyle.js - 小班（SHOHAN / shohan）データ専用スタイルおよびズーム別表示制御
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  /** 小班枠線およびラベル文字の標準色（細い灰色） */
  const SHOHAN_COLOR = '#64748b';
  /** rinpanの枠線(1.2px)の半分以下: 0.6px */
  const SHOHAN_WEIGHT = 0.6;
  /** ズームレベル16以上で枠線を表示 */
  const MIN_ZOOM_SHOHAN_POLYGON = 16;
  /** ズームレベル17以上でラベルを表示 */
  const MIN_ZOOM_SHOHAN_LABEL = 17;

  let zoomWatcherAttached = false;

  GIS.ShohanStyle = {
    COLOR: SHOHAN_COLOR,
    WEIGHT: SHOHAN_WEIGHT,
    MIN_ZOOM_POLYGON: MIN_ZOOM_SHOHAN_POLYGON,
    MIN_ZOOM_LABEL: MIN_ZOOM_SHOHAN_LABEL,

    /**
     * ファイル名、レイヤー名、またはフィーチャプロパティから小班データか判定する
     * @param {string} [layerName]
     * @param {File|string} [fileOrUrl]
     * @param {object} [feature]
     * @returns {boolean}
     */
    isShohan(layerName, fileOrUrl, feature) {
      const fileName = (fileOrUrl && typeof fileOrUrl === 'object' && fileOrUrl.name)
        ? fileOrUrl.name
        : (typeof fileOrUrl === 'string' ? fileOrUrl : '');

      const text = `${layerName || ''} ${fileName}`;
      if (/shohan|小班/i.test(text)) return true;

      // プロパティキーに SHOHAN / shohan / 小班 が含まれる場合
      if (feature && feature.properties) {
        const keys = Object.keys(feature.properties);
        if (keys.some(k => /shohan|小班/i.test(k) && !/林班/i.test(k))) return true;
      }

      return false;
    },

    /**
     * 小班ポリゴンのスタイル（rinpanの半分以下の細さ、塗りつぶしなし）
     * @returns {object}
     */
    getStyle() {
      return {
        color: SHOHAN_COLOR,
        weight: SHOHAN_WEIGHT,
        opacity: 0.95,
        fill: false,
        fillColor: 'transparent',
        fillOpacity: 0,
        className: 'shohan-polygon-layer'
      };
    },

    /**
     * フィーチャから小班番号を取得する
     * @param {object} feature
     * @returns {string}
     */
    getShohanNo(feature) {
      if (!feature || !feature.properties) return '';
      const p = feature.properties;

      // 小班番号候補プロパティを優先順に検索
      const candidates = [
        p.SHOHAN,
        p.shohan,
        p.Shohan,
        p['小班'],
        p['小班番号'],
        p['林小班'],
        p.SHOHAN_NO,
        p.shohan_no,
        p.NAME,
        p.name,
        p.NO,
        p.no
      ];

      for (const val of candidates) {
        if (val != null && val !== '') {
          return String(val).trim();
        }
      }

      return '';
    },

    /**
     * ポリゴンの中心に小班番号ラベルを表示（rinpanより1ポイント以上小さいフォント＋白縁取り）
     * @param {L.Layer} layer
     * @param {string} shohanNo
     */
    applyCenterLabel(layer, shohanNo) {
      if (!layer || !shohanNo) return;

      const labelHtml = `<span class="shohan-label-text">${this._escHtml(shohanNo)}</span>`;
      layer.bindTooltip(labelHtml, {
        permanent: true,
        direction: 'center',
        className: 'shohan-center-label'
      });

      this.setupZoomWatcher(GIS.AppState ? GIS.AppState.map : null);
    },

    /**
     * ズームレベル監視（ズーム16以上で枠線表示、ズーム17以上でラベル表示）
     * @param {L.Map} map
     */
    setupZoomWatcher(map) {
      if (!map) return;
      if (!zoomWatcherAttached) {
        zoomWatcherAttached = true;
        const update = () => this.updateZoomVisibility(map);
        map.on('zoom zoomend moveend', update);
      }
      this.updateZoomVisibility(map);
    },

    /**
     * ズームレベルに応じたクラスの付与・削除
     * @param {L.Map} map
     */
    updateZoomVisibility(map) {
      if (!map) return;
      const container = map.getContainer();
      if (!container) return;
      const zoom = map.getZoom();
      container.classList.toggle('shohan-polygons-hidden', zoom < MIN_ZOOM_SHOHAN_POLYGON);
      container.classList.toggle('shohan-labels-hidden', zoom < MIN_ZOOM_SHOHAN_LABEL);
    },

    /**
     * HTMLエスケープ
     */
    _escHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      if (GIS.AppState && GIS.AppState.map) {
        GIS.ShohanStyle.setupZoomWatcher(GIS.AppState.map);
      }
    }, 300);
  });

})(window.GIS = window.GIS || {});
