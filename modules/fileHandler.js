/**
 * fileHandler.js - ファイルタイプ判定と適切なハンドラへの振り分け
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  /** サポートする拡張子とハンドラのマッピング */
  const EXT_MAP = {
    kml:     'kml',
    kmz:     'kml',
    geojson: 'geojson',
    json:    'geojson',
    gpx:     'gpx',
    tif:     'geotiff',
    tiff:    'geotiff',
    jpg:     'image',
    jpeg:    'image',
    png:     'image',
    heic:    'image',
    heif:    'image',
    webp:    'image',
    fgb:     'flatgeobuf',
    shp:     'shapefile',
    shx:     'shapefile_part',
    dbf:     'shapefile_part',
    prj:     'shapefile_part',
    cpg:     'shapefile_part',
    zip:     'zip',
  };

  GIS.FileHandler = {

    /**
     * ファイル名から拡張子を取り除いたベース名を返す
     * 例: 'shohan.geojson' -> 'shohan', 'data.kml' -> 'data'
     * @param {string} filename
     * @returns {string}
     */
    stripExtension(filename) {
      if (!filename) return '';
      const base = String(filename).replace(/\.[^/.]+$/, '');
      return base || filename;
    },

    /**
     * ファイル配列を受け取り、各ファイルを適切なハンドラへ振り分ける
     * @param {File[]} files
     */
    async handleFiles(files) {
      const fileList = Array.from(files || []);
      if (!fileList.length) return;

      // 1. シェープファイル関連ファイル（.shp, .dbf, .shx, .prj, .cpg）のグループ化
      const shpPartsExts = ['shp', 'dbf', 'shx', 'prj', 'cpg'];
      const shpGroups = new Map(); // baseName -> { baseName, shp, dbf, shx, prj, cpg, otherFiles: [] }
      const remainingFiles = [];

      for (const file of fileList) {
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        if (shpPartsExts.includes(ext)) {
          const baseName = this.stripExtension(file.name);
          if (!shpGroups.has(baseName)) {
            shpGroups.set(baseName, { baseName });
          }
          shpGroups.get(baseName)[ext] = file;
        } else {
          remainingFiles.push(file);
        }
      }

      // シェープファイルグループの処理
      for (const [baseName, group] of shpGroups.entries()) {
        if (group.shp) {
          try {
            if (GIS.ShapefileHandler) {
              await GIS.ShapefileHandler.loadGroup(group);
              if (GIS.LayerHistoryHandler) {
                GIS.LayerHistoryHandler.recordFile(group.shp, 'shp');
              }
            } else {
              throw new Error('ShapefileHandler が初期化されていません。');
            }
          } catch (err) {
            console.error('[FileHandler] Shapefile group error:', baseName, err);
            GIS.UI.showToast(`❌ Shapefile読み込みエラー: ${baseName}\n${err.message}`, 'error');
          }
        } else {
          // .shp が含まれていない孤立した補助ファイル
          const partNames = Object.keys(group).filter(k => k !== 'baseName').map(k => `.${k}`).join(', ');
          GIS.UI.showToast(`⚠️ シェープファイルの一部 (${partNames}) のみ選択されています。対応する .shp ファイルと一緒にドラッグ＆ドロップしてください。`, 'warn');
        }
      }

      // 2. その他のファイルの処理
      for (const file of remainingFiles) {
        const type = this._detectType(file);
        if (!type) {
          GIS.UI.showToast(`⚠️ 非対応のファイル形式です: ${file.name}`, 'warn');
          continue;
        }

        GIS.UI.showToast(`📂 読み込み中: ${file.name}`, 'info');
        try {
          switch (type) {
            case 'kml':
              await GIS.KmlParser.load(file);
              break;
            case 'geojson':
              await GIS.GeoJsonHandler.load(file);
              break;
            case 'gpx':
              await GIS.GpxHandler.load(file);
              break;
            case 'image':
              await GIS.ImageHandler.load(file);
              break;
            case 'geotiff':
              await GIS.GeoTiffHandler.load(file);
              break;
            case 'flatgeobuf':
              if (GIS.FlatGeobufHandler) {
                await GIS.FlatGeobufHandler.load(file);
              } else {
                throw new Error('FlatGeobufHandler が読み込まれていません。');
              }
              break;
            case 'zip':
              if (GIS.ShapefileHandler) {
                await GIS.ShapefileHandler.loadZip(file);
              } else {
                throw new Error('ShapefileHandler が読み込まれていません。');
              }
              break;
          }

          // 正常に読み込まれたらIndexedDB履歴に保存
          if (GIS.LayerHistoryHandler) {
            const historyType = type === 'zip' ? 'shp' : (type === 'flatgeobuf' ? 'fgb' : type);
            GIS.LayerHistoryHandler.recordFile(file, historyType);
          }
        } catch (err) {
          console.error('[FileHandler] Error:', file.name, err);
          GIS.UI.showToast(`❌ 読み込みエラー: ${file.name}\n${err.message}`, 'error');
        }
      }
    },

    /**
     * ファイルのタイプを判定する
     * MIMEタイプと拡張子の両方で判定（堅牢性確保）
     * @param {File} file
     * @returns {string|null}
     */
    _detectType(file) {
      // 拡張子で判定
      const ext = file.name.split('.').pop().toLowerCase();
      if (EXT_MAP[ext]) return EXT_MAP[ext];

      // MIMEタイプで判定（拡張子がない場合のフォールバック）
      const mime = file.type.toLowerCase();
      if (mime.includes('kml')) return 'kml';
      if (mime === 'application/geo+json' || mime === 'application/json') return 'geojson';
      if (mime === 'application/gpx+xml' || mime.includes('gpx')) return 'gpx';
      if (mime.startsWith('image/tiff')) return 'geotiff';
      if (mime.startsWith('image/')) return 'image';
      if (mime.includes('zip') || mime.includes('compressed')) return 'zip';

      return null;
    }
  };

})(window.GIS = window.GIS || {});
