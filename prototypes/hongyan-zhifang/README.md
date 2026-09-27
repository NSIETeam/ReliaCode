# 鸿雁知访统一设计预览

当前电脑没有鸿雁知访原始 Vue 源码仓库，线上也未公开 source map。本目录用于保存第一轮可审查的产品家族设计、独立视觉素材以及不改变现有 API 的主题覆盖层。

## 本地预览

```powershell
npm run dev
```

打开 `http://127.0.0.1:4178/login`。本地服务会把 `/api/*` 原样代理到现有鸿雁知访服务器，账号密码只由浏览器直接提交，不会写入本地文件。

## 交付边界

- `public/assets/app.js` 与 `public/assets/base.css` 是当前线上公开构建的只读基线。
- `public/assets/hongyan-theme-v1.css` 是第一轮整站统一主题，可迁移回原始 Vue 源码。
- 未取得原始源码前，不直接覆盖生产构建文件，也不把压缩产物冒充可维护源码。
