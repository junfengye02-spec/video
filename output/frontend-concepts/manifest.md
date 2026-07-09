# OpenMontage Frontend Concept Images

Generated on 2026-07-09 for the login-and-recharge product direction.

## Method

The provided image2 gateway was tested first. The model list endpoint returned `gpt-image-2`, but image generation requests either returned `Your request was blocked` or timed out with HTTP 524. To keep the work moving and preserve exact Chinese UI copy, the final deliverables were rendered locally from `mockups.html` and exported as PNG screenshots.

No real API key, model name, provider name, gateway URL, or payment-provider logo appears in the final images.

## Files

- `login-register.png`: 登录/注册页。Validated as a complete beginner-friendly entry screen with product preview and no technical key fields.
- `wallet-plans.png`: 充值/套餐页。Validated with balance, packages, estimated point usage, and recharge action.
- `create-home.png`: 创作首页。Validated with story input, project type, duration, style options, and a clear "生成分镜" action.
- `storyboard-workbench.png`: 分镜工作台。Validated with shot list, current shot editor, hidden advanced settings, character consistency, progress, and point estimate.
- `asset-library.png`: 资源库/角色页。Validated with upload area, category tabs, asset cards, and character-locking guidance.
- `render-download.png`: 最终渲染/下载页。Validated with preview, four-step progress, point usage, download, edit, and share actions.

## Source Files

- `prompts.md`: original image-generation prompt set.
- `mockups.html`: deterministic local mockup source used to render the final PNGs.
