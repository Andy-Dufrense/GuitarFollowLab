// 检测能力（后端能力）的实体在 backend/engine/ —— 前端这里只留一行转接：
//   浏览器：/js/engine/analysis.js → 这一行 → /backend/engine/analysis.js（服务端只读路由）
//   Node（离线回归）：同一条相对路径直接落到仓库里的 backend/engine/analysis.js
export * from '../../../backend/engine/analysis.js?v=0924-1925';
