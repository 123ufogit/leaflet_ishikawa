/**
 * rinpanStyle.js - 林班（RINPAN / rinpan）データ専用スタイルおよびラベル制御
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  /** 林班枠線およびラベル文字の標準色（細い灰色） */
  const RINPAN_COLOR = '#64748b';
  const RINPAN_WEIGHT = 1.2;
  const MIN_ZOOM_RINPAN_LABEL = 15;

  let zoomWatcherAttached = false;

  GIS.RinpanStyle = {
    COLOR: RINPAN_COLOR,
    WEIGHT: RINPAN_WEIGHT,
    MIN_ZOOM: MIN_ZOOM_RINPAN_LABEL,

    /**
     * ファイル名、レイヤー名、またはフィーチャプロパティから林班データか判定する
     * @param {string} [layerName]
     * @param {File|string} [fileOrUrl]
     * @param {object} [feature]
     * @returns {boolean}
     */
    isRinpan(layerName, fileOrUrl, feature) {
      const fileName = (fileOrUrl && typeof fileOrUrl === 'object' && fileOrUrl.name)
        ? fileOrUrl.name
        : (typeof fileOrUrl === 'string' ? fileOrUrl : '');

      const text = `${layerName || ''} ${fileName}`;
      if (/rinpan|森林計画/i.test(text)) return true;

      // プロパティキーに RINPAN / rinpan が含まれる場合
      if (feature && feature.properties) {
        const keys = Object.keys(feature.properties);
        if (keys.some(k => /rinpan|森林計画/i.test(k))) return true;
      }

      return false;
    },

    /**
     * 林班ポリゴンのスタイル（細い灰色、塗りつぶしなし）
     * @returns {object}
     */
    getStyle() {
      return {
        color: RINPAN_COLOR,
        weight: RINPAN_WEIGHT,
        opacity: 0.95,
        fill: false,
        fillColor: 'transparent',
        fillOpacity: 0,
        className: 'rinpan-polygon-layer'
      };
    },

    /**
     * フィーチャから林班番号を取得する
     * @param {object} feature
     * @returns {string}
     */
    getRinpanNo(feature) {
      if (!feature || !feature.properties) return '';
      const p = feature.properties;

      // よくある林班番号プロパティ名を優先順に検索
      const candidates = [
        p.RINPAN,
        p.rinpan,
        p.Rinpan,
        p['林班'],
        p['林班番号'],
        p['林小班'],
        p.RINPAN_NO,
        p.rinpan_no,
        p.NO,
        p.No,
        p.no,
        p.NAME,
        p.name
      ];

      for (const val of candidates) {
        if (val != null && val !== '') {
          return String(val).trim();
        }
      }

      return '';
    },

    /**
     * ポリゴンの中心に林班番号ラベルを常時表示（枠線色＋白縁取り）
     * @param {L.Layer} layer
     * @param {string} rinpanNo
     */
    applyCenterLabel(layer, rinpanNo) {
      if (!layer || !rinpanNo) return;

      const labelHtml = `<span class="rinpan-label-text">${this._escHtml(rinpanNo)}</span>`;
      layer.bindTooltip(labelHtml, {
        permanent: true,
        direction: 'center',
        className: 'rinpan-center-label'
      });

      this.setupZoomWatcher(GIS.AppState ? GIS.AppState.map : null);
    },

    /**
     * ズームレベル監視（ズーム15以上でのみラベル表示）
     * @param {L.Map} map
     */
    setupZoomWatcher(map) {
      if (!map || zoomWatcherAttached) return;
      zoomWatcherAttached = true;

      const updateLabelVisibility = () => {
        const container = map.getContainer();
        if (!container) return;
        const zoom = map.getZoom();
        container.classList.toggle('rinpan-labels-hidden', zoom < MIN_ZOOM_RINPAN_LABEL);
      };

      map.on('zoom zoomend', updateLabelVisibility);
      updateLabelVisibility();
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

})(window.GIS = window.GIS || {});
