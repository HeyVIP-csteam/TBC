# 2026-11-02 — 所有 Topic 附件规则统一

**以前**：只有 Cyber Complaint 可以传 5 个文件 + 视频，其他 Topic 最多 3 个、只能图片 / PDF。

**现在每个 Topic（INR / PKR / PHP 全部）一样**：

- 最多 **5 个文件**
- 可以传 **JPG / PNG / WebP / PDF / MP4 / MOV / WebM**
- 每个 **20MB**，合计 **30MB**（附件放在同一个请求里上传，合计上限是为了不超出服务器内存）
- 图片和视频在 Telegram 里合成一个相册，视频可直接播放

同样适用于 TG Reply Threads 的「Generate to another Topic」（新增附件也改成 5 个 / 可传视频 / 合计 30MB；
从原工单带过去的视频也会以视频发送）。

## 改动文件

- `public/assets/schemas.js` — `DEFAULT_ATTACHMENTS` 改成统一规则（所有 Topic 共用）
- `functions/api/submit.js` — 后端上限统一为 5
- `functions/api/forward.js` — 转发时支持视频（sendVideo / 相册 video）
- `public/threads.html` — 转发弹窗的附件上限、提示文字、可选文件类型
- `public/form.html` — 默认提示文字

## 已验证

- 后端：Withdraw Issue 传 5 个（照片 + 视频）成功并合成相册；6 个被拒绝；Cyber Complaint 不受影响。
- 浏览器：INR 8 个 + PHP 9 个 Topic 表单全部显示「Max 5 files … 30MB total」，文件选择允许视频。
