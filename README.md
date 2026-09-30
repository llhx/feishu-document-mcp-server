# Feishu Document MCP Server

一个只读的 [Model Context Protocol（MCP）](https://modelcontextprotocol.io/)服务，用于访问飞书/Lark Docx 文档、以 Docx 为内容载体的知识库页面，以及文档内嵌图片。

它通过飞书开放平台官方 API，让 Qoder 等 MCP 客户端能够读取文档文字、分析文档结构并获取内嵌图片。

## 功能特性

- 通过飞书 Docx 链接或文档 Token 读取文档
- 将飞书知识库链接解析为其对应的 Docx 文档
- 提取标题、正文、列表、代码块、引用、提及等常见区块中的文字
- 返回图片清单，包括图片 Token、区块 ID、宽度和高度
- 将文档内嵌图片直接作为 MCP 图片内容返回
- 通过媒体 Token 单独获取指定图片
- 使用带 PKCE 的飞书官方 OAuth 完成用户授权
- 自动刷新已保存的用户访问令牌
- 没有可用用户令牌时，自动回退到租户访问令牌
- 将文档和图片读取操作声明为 MCP 只读工具

## 环境要求

- Node.js 20 或更高版本
- 一个飞书开放平台应用
- 对目标文档具有访问权限
- 一个支持 MCP 的客户端

## 安装

推荐通过 `npx` 使用，无需全局安装：

```bash
npx -y feishu-document-mcp-server
```

也可以全局安装：

```bash
npm install -g feishu-document-mcp-server
feishu-document-mcp-server
```

服务通过标准输入输出（`stdio`）通信，通常应由 MCP 客户端启动，而不是直接在交互式终端中运行。

## 配置飞书应用

1. 在[飞书开放平台](https://open.feishu.cn/)创建应用。
2. 获取应用 ID 和应用密钥。
3. 为应用添加以下只读权限：

```text
offline_access
docx:document:readonly
wiki:node:read
docs:document.media:download
```

4. 为应用添加以下 OAuth 重定向地址：

```text
http://localhost:3000/callback
```

5. 根据组织要求发布应用，并在对应的飞书租户中安装应用。

最终可以访问哪些文档，同时取决于飞书应用权限和当前用户的文档权限。

## MCP 客户端配置

将服务添加到 MCP 配置中。具体配置文件位置取决于所使用的 MCP 客户端。

```json
{
  "mcpServers": {
    "feishu-document": {
      "command": "npx",
      "args": ["-y", "feishu-document-mcp-server"],
      "env": {
        "FEISHU_APP_ID": "your_app_id",
        "FEISHU_APP_SECRET": "your_app_secret",
        "FEISHU_API_BASE_URL": "https://open.feishu.cn",
        "FEISHU_OAUTH_REDIRECT_URI": "http://localhost:3000/callback"
      }
    }
  }
}
```

修改配置后，需要重新加载或重启 MCP 客户端。

> 请勿将应用密钥、访问令牌或包含真实凭证的 MCP 配置文件提交到代码仓库。

## 授权方式

### 推荐方式：用户 OAuth

用户 OAuth 允许服务访问已授权用户有权查看的文档，具体范围同时受飞书应用已申请权限的限制。

1. 调用 `feishu_auth_status` 检查当前授权状态。
2. 调用 `feishu_start_readonly_authorization`。
3. 在浏览器中打开返回的授权链接。
4. 同意所请求的权限。
5. 等待浏览器提示授权完成。
6. 再次调用 `feishu_auth_status`，或者直接读取文档。

存在刷新令牌时，服务会自动刷新用户访问令牌。

### 租户访问令牌回退

没有可用的用户访问令牌时，服务会通过 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET` 获取租户访问令牌。租户访问令牌只能访问应用有权访问的内容，其权限范围可能与具体用户不同。

### 直接提供用户访问令牌

如果访问令牌由外部系统管理，或者仅用于临时调试，可以设置：

```text
FEISHU_USER_ACCESS_TOKEN=your_user_access_token
```

服务会直接使用该令牌，但不会自动刷新通过环境变量传入的令牌。

## 环境变量

| 变量 | 是否必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `FEISHU_APP_ID` | 是 | — | 飞书应用 ID，也兼容 `APP_ID`。 |
| `FEISHU_APP_SECRET` | 是 | — | 飞书应用密钥，也兼容 `APP_SECRET`。 |
| `FEISHU_API_BASE_URL` | 否 | `https://open.feishu.cn` | 飞书开放 API 地址，也兼容 `LARK_DOMAIN`。 |
| `FEISHU_ACCOUNTS_BASE_URL` | 否 | `https://accounts.feishu.cn` | 飞书 OAuth 账号服务地址。 |
| `FEISHU_OAUTH_REDIRECT_URI` | 否 | `http://localhost:3000/callback` | 本地 OAuth 回调地址，仅支持 `localhost` 和 `127.0.0.1`。 |
| `FEISHU_READONLY_SCOPES` | 否 | 见下方 | 使用逗号或空格分隔的 OAuth 权限列表。 |
| `FEISHU_USER_ACCESS_TOKEN` | 否 | — | 直接使用的用户访问令牌，会绕过本地 OAuth 流程。 |

默认权限：

```text
offline_access docx:document:readonly wiki:node:read docs:document.media:download
```

## 可用工具

### `feishu_auth_status`

检查飞书应用是否已配置，以及本地是否存在有效的用户授权。该工具不会返回任何令牌值。

参数：无。

### `feishu_start_readonly_authorization`

启动飞书官方 OAuth 授权流程，返回授权链接、重定向地址和请求的权限列表。

参数：无。

### `feishu_read_document`

读取飞书文档，返回文档元数据、提取后的文字和图片清单，并可选择将图片作为 MCP 图片内容返回。

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `source` | string | 必填 | `/wiki/...` 链接、`/docx/...` 链接、知识库 Token 或 Docx Token。 |
| `sourceType` | `auto` \| `wiki` \| `docx` | `auto` | `source` 不是链接时用于指定 Token 类型。 |
| `includeImages` | boolean | `true` | 是否在 MCP 响应中包含文档图片。 |
| `maxImages` | integer | `20` | 单次最多返回的图片数量，取值范围为 0～50。 |
| `includeRawBlocks` | boolean | `false` | 是否在文字响应末尾附加原始 Docx 区块 JSON。 |

工具调用参数示例：

```json
{
  "source": "https://example.feishu.cn/wiki/your_wiki_token",
  "sourceType": "auto",
  "includeImages": true,
  "maxImages": 20,
  "includeRawBlocks": false
}
```

### `feishu_get_document_image`

使用 `feishu_read_document` 返回的图片清单中的媒体 Token，获取单张文档图片。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `token` | string | 文档图片清单中的媒体 Token。 |

工具调用参数示例：

```json
{
  "token": "image_media_token"
}
```

## 支持范围与限制

- 支持直接读取 Docx 链接和 Token。
- 支持知识库链接和 Token，但对应知识库节点的实际内容必须是 Docx 文档。
- 暂不完整读取以电子表格、多维表格、思维笔记等其他类型为内容载体的知识库节点。
- 常见富文本区块会转换为带区块类型标识的可读纯文本。
- 内嵌电子表格、多维表格、文件、画板等区块仅展示元数据，不会获取其完整内容。
- `feishu_read_document` 默认最多包含 20 张图片，单次最多可配置为 50 张。
- 大于 10 MB 的图片不会包含在文档综合响应中，可通过 `feishu_get_document_image` 单独请求。
- 长文档开启 `includeRawBlocks` 后，可能产生非常大的响应。
- 飞书内容操作均为只读；启动 OAuth 授权时会在本地保存授权信息。

## 令牌存储与安全

- 在 macOS 中，OAuth 令牌保存在系统钥匙串中。
- 在其他平台中，令牌保存在 `~/.config/feishu-document-mcp/tokens.json`，并设置受限的文件权限。
- MCP 工具不会返回应用密钥或访问令牌值。
- OAuth 回调服务仅允许使用 `localhost` 或 `127.0.0.1`。
- 应仅申请必要的飞书权限，并妥善保管应用密钥。
- 如果凭证或令牌可能已经泄露，请及时在飞书开放平台中撤销授权并更换凭证。

## 常见问题

### 缺少应用凭证

确认 MCP 服务环境中已经配置 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`，然后重新加载 MCP 客户端。

### 读取文档时提示无权限

请检查：

- 当前授权用户能否在飞书中打开该文档
- 飞书应用是否已开通所需的只读权限
- 应用是否已发布并安装到对应租户
- 使用租户访问令牌时，目标文档是否已向应用开放

### OAuth 回调失败

确认飞书开放平台中配置的重定向地址与 `FEISHU_OAUTH_REDIRECT_URI` 完全一致，并检查对应本地端口是否已被其他程序占用。

### 知识库节点不是 Docx 文档

服务可以解析知识库节点，但目前只会完整读取底层类型为 `docx` 的文档。

### 无法获取图片

确认应用已开通 `docs:document.media:download` 权限，且 `includeImages` 为 `true`。可以检查返回的图片清单，再通过 `feishu_get_document_image` 获取指定图片。

## 版本更新

本包通过 `prepack` 脚本自动编译 TypeScript 源码后再发布到 npm。

如需了解项目源码、本地开发或贡献代码，请访问 [GitHub 仓库](https://github.com/llhx/feishu-document-mcp-server)。
