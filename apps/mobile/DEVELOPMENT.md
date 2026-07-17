# 手机 App 开发说明

## 当前阶段

当前分支完成第一版手机 App 壳和 Voice Session API 接入：

```text
手机 App
  ↓ POST /v1/voice/sessions
Aipany Voice Session Service
  ↓
返回短期实时语音会话启动数据
```

此阶段还没有建立真正的 WebRTC 音频连接。下一步将在同一 App 中加入原生 WebRTC 模块、麦克风权限、实时音频和会话清理。

## 技术栈

- Expo SDK 55
- React Native 0.83
- TypeScript
- pnpm Monorepo

采用 Expo 的原因是先提高手机端产品迭代效率；后续实时语音需要原生 WebRTC 模块时使用 Development Build，而不是依赖 Expo Go。

## 启动

在仓库根目录安装依赖：

```bash
pnpm install
```

启动 Voice Session 后端：

```bash
pnpm --filter @aipany/voice-session dev
```

启动手机 App：

```bash
pnpm --filter @aipany/mobile start
```

## 后端地址

复制：

```text
apps/mobile/.env.example
```

为：

```text
apps/mobile/.env
```

然后配置：

```text
EXPO_PUBLIC_API_BASE_URL=http://你的后端地址:3000
```

注意：

- Android 模拟器访问电脑本机通常使用 `http://10.0.2.2:3000`；
- iOS 模拟器通常可以使用 `http://localhost:3000`；
- 手机真机需要使用电脑的局域网 IP；
- App 中禁止保存 OpenAI 或任何第三方模型的永久 API Key。

## 当前交互流程

用户点击“开始语音会话”后：

1. App 生成当前开发设备身份；
2. App 向 Aipany 后端请求实时语音 Session；
3. 后端检查设备是否具备音频输入输出 Capability；
4. 后端向实时语音 Provider 申请短期凭证；
5. App 收到统一的 Session Bootstrap 数据；
6. 页面进入“已准备”状态。

下一阶段会把第 6 步替换为真正的 WebRTC 建连并开始持续双向语音。
