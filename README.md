# 🗺️ GIS Browser — Leaflet Standalone WebGIS Engine

> KML・GeoJSON・GPX・画像・GeoTIFFをドラッグ＆ドロップで地図表示。能登半島LiDARオープンデータ一括表示・360°全天球画像プレビュー・位置指定・PDF出力まで対応したスタンドアロン型 WebGIS ブラウザ。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Leaflet](https://img.shields.io/badge/Leaflet-1.9.4-green.svg)](https://leafletjs.com)
[![VectorGrid](https://img.shields.io/badge/VectorGrid-Supported-emerald.svg)](https://leafletjs.com)

---

## ✨ 主な機能一覧

| 機能 | 説明 |
|------|------|
| 📂 **D&D ファイル読み込み** | KML / GeoJSON / GPX / JPEG / PNG / HEIC / GeoTIFF をドラッグ＆ドロップ |
| 🌲 **能登半島LiDARデータ一括表示** | CS立体図、DCHMグレースケール加工、地形変化量2色スケール、簡易オルソ、樹種2024、判読図2024を一括表示 |
| 📊 **左下折りたたみ凡例パネル** | 表示中の能登半島LiDARデータ・樹種・判読図のカラー凡例を動的生成・折りたたみ表示 |
| 📍 **EXIF 位置情報読み取り** | 写真の GPS 情報を自動抽出してピン表示 |
| 🌐 **360°全天球画像プレビュー** | Pannellum ビューアでパノラマ・全天球画像をインタラクティブ表示 |
| 📌 **撮影位置の特定** | 位置情報なし画像を地図クリックでピン付け |
| 🛰️ **GeoTIFF 表示** | 衛星画像・標高データを地理参照付きで重ね合わせ（WGS84 / 平面直交座標系 自動変換） |
| 🗜️ **自動圧縮・リサンプリング** | 500MB 超の GeoTIFF もブラウザ内で自動圧縮（最大 2048px） |
| 💾 **GeoJSON / KML エクスポート** | 追加したピン情報を標準フォーマットで保存 |
| 📄 **PDF / PNG 出力** | 地図画面を A4 PDF または PNG で保存 |
| 🗾 **ベースマップ切り替え** | 国土地理院標準地図・空中写真・OpenStreetMap |

---

## 🚀 GitHub Pages への公開手順 (Web公開方法)

本リポジトリの全ファイルをそのまま GitHub のリポジトリにアップロードするだけで、完全な WebGIS アプリケーションとして動作します。

1. **GitHub でリポジトリを作成**:
   - 新しいリポジトリを作成（例: `gis-browser`）。
2. **ファイルをコミット＆プッシュ**:
   - 本フォルダ内のファイル一式を `main` ブランチにコミットしてプッシュします。
3. **GitHub Pages を有効化**:
   - リポジトリの **Settings** → **Pages** を開く。
   - **Source**: `Deploy from a branch` を選択。
   - **Branch**: `main` / `/(root)` を選択して **Save** をクリック。
4. **公開完了**:
   - 数分で `https://<your-username>.github.io/<repository-name>/` で公開され、ブラウザから利用可能になります！

---

## 📁 ファイル構成

```
gis-browser/
├── index.html            # メインエントリポイント (GitHub Pages用)
├── gis_browser.css       # メインスタイルシート (Dark Glassmorphism UI)
├── LICENSE               # MIT ライセンス
├── README.md             # プロジェクト説明書
├── modules/              # 全 JavaScript モジュール群
│   ├── gis_browser.js    # アプリケーションメイン初期化
│   ├── appState.js       # 中央状態管理 & レイヤーイベントバス
│   ├── floatingPanel.js  # ドラッグ可能UIパネル
│   ├── fileHandler.js    # D&D ファイル判定 & 振り分け
│   ├── kmlParser.js      # KML/KMZ 解析
│   ├── geojsonHandler.js # GeoJSON 描画
│   ├── geotiffHandler.js # GeoTIFF デコード・圧縮
│   ├── gpxHandler.js     # GPX トラック・ルート描画
│   ├── imageHandler.js   # EXIF GPS 抽出 & マップピンプロット
│   ├── pinEditor.js      # 撮影位置特定 & 360°パノラマビューア
│   ├── notoLidarHandler.js # ★ 能登半島LiDARレイヤー一括制御 & 左下凡例
│   ├── zoningHandler.js  # ゾーニング解析連携
│   ├── exportHandler.js  # GeoJSON / KML / PDF 出力
│   └── ui.js             # 共通モーダル・トーストUI
└── spec-kit/             # 設計仕様書キット (spec-kit)
    ├── README.md
    ├── 01_architecture_spec.md
    ├── 02_data_and_layer_spec.md
    ├── 03_feature_extension_spec.md
    └── 04_ui_ux_guidelines.md
```

---

## 🔒 プライバシー & セキュリティ

- すべてのファイル処理・画像解析・地理計算は**お使いのブラウザ内（ローカル）でのみ完結**します。
- 位置情報やドロップされたファイルが外部サーバーへ送信されることは一切ありません。

---

## 📄 ライセンス

[MIT License](LICENSE) — 自由に使用・改変・再配布が可能です。
