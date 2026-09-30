# Feishu Document MCP Server

一个只读的 [MCP（Model Context Protocol）](https://modelcontextprotocol.io/) 服务，用于访问飞书 / Lark 文档、电子表格、多维表格、思维笔记、知识库与云盘文件，并获取文档内嵌图片。

| 项目 | 说明 |
| --- | --- |
| 通信方式 | stdio，由 MCP 客户端拉起 |
| 使用方式 | `npx -y feishu-document-mcp-server`，无需全局安装 |
| 权限模型 | 仅只读工具；用户 OAuth 优先，无用户令牌时回退租户令牌 |

## 快速开始

需要 Node.js 20 或更高版本。

1. **[配置飞书应用](#配置飞书应用)** —— 创建应用、开通只读权限、添加 OAuth 重定向地址
2. **[添加 MCP 客户端配置](#mcp-客户端配置)** —— 填入应用凭证，重启客户端
3. **读取任意飞书文档** —— 首次调用时自动弹出授权链接，在浏览器中完成授权即可

## 目录

- [配置飞书应用](#配置飞书应用)
- [MCP 客户端配置](#mcp-客户端配置)
- [授权方式](#授权方式)
- [环境变量](#环境变量)
- [可用工具](#可用工具)
- [支持范围与限制](#支持范围与限制)
- [令牌存储与安全](#令牌存储与安全)
- [常见问题](#常见问题)

## 配置飞书应用

1. 在[飞书开放平台](https://open.feishu.cn/)创建应用（[教程](https://open.feishu.cn/document/uQjL04CN/ukzM04SOzQjL5MDN)）。
2. 获取**应用 ID** 和**应用密钥**（[教程](https://open.feishu.cn/document/faq/trouble-shooting/how-to-obtain-app-id)）。
3. 为应用添加以下只读权限（[教程](https://open.feishu.cn/document/server-docs/application-scope/introduction)）。未启用的权限会在授权时自动跳过，不影响其他权限的授权：

   ```text
   offline_access
   docx:document:readonly
   wiki:node:read
   sheets:spreadsheet:readonly
   bitable:app:readonly
   drive:drive:readonly
   docs:document.media:download
   ```

4. 为应用添加 OAuth 重定向地址：

   ```text
   http://localhost:3000/callback
   ```

5. 根据组织要求发布应用，并在对应的飞书租户中安装应用。

> 最终可以访问哪些文档，同时取决于飞书应用权限和当前用户的文档权限。

## MCP 客户端配置

将服务添加到 MCP 配置中，配置文件位置取决于所使用的 MCP 客户端：

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

> **注意**：请勿将应用密钥、访问令牌或包含真实凭证的 MCP 配置文件提交到代码仓库。

## 授权方式

服务获取访问令牌的优先级为：**用户 OAuth → 租户访问令牌**。

### 用户 OAuth（推荐）

用户 OAuth 允许服务访问已授权用户有权查看的文档，具体范围同时受飞书应用已申请权限的限制。

**自动授权**：调用 `feishu_read_document`、`feishu_get_document_image` 或 `feishu_get_file` 时，如果检测到没有有效的用户令牌，工具会自动返回 OAuth 授权链接。在浏览器中打开链接并完成授权后，重新调用即可读取文档。

**手动授权**：也可以主动调用 `feishu_start_readonly_authorization` 提前完成授权。

**重新授权**：调用 `feishu_reset_authorization` 可清除已保存的令牌并发起新的授权流程，适用于切换飞书账号、更新应用权限后重新授权、或授权状态异常需要重置的场景。

**确认授权结果**：授权完成后，可调用 `feishu_auth_status` 查看当前授权状态，确认 `userAuthenticated` 为 `true` 后直接读取文档。

**Scope 自动过滤**：授权前会自动检查飞书应用中实际已启用的权限，未启用的 scope 会被自动跳过并告知用户，不会因为单个权限未启用而导致整个授权失败。如需使用被跳过的权限，在飞书应用后台启用并发布后重新授权即可。

存在刷新令牌时，服务会自动刷新用户访问令牌（有效期约 30 天）。

### 其他令牌来源

- **租户访问令牌回退**：无用户授权时自动通过应用凭证获取，只能访问应用有权访问的内容。
- **直接提供用户令牌**：设置 `FEISHU_USER_ACCESS_TOKEN` 环境变量，适用于外部系统管理令牌或临时调试，不会自动刷新。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | :---: | --- | --- |
| `FEISHU_APP_ID` | 是 | — | 飞书应用 ID，兼容 `APP_ID` |
| `FEISHU_APP_SECRET` | 是 | — | 飞书应用密钥，兼容 `APP_SECRET` |
| `FEISHU_API_BASE_URL` | 否 | `https://open.feishu.cn` | 飞书开放 API 地址，兼容 `LARK_DOMAIN` |
| `FEISHU_ACCOUNTS_BASE_URL` | 否 | `https://accounts.feishu.cn` | 飞书 OAuth 账号服务地址 |
| `FEISHU_OAUTH_REDIRECT_URI` | 否 | `http://localhost:3000/callback` | 本地 OAuth 回调地址，仅支持 `localhost` 和 `127.0.0.1` |
| `FEISHU_READONLY_SCOPES` | 否 | `offline_access docx:document:readonly wiki:node:read sheets:spreadsheet:readonly bitable:app:readonly drive:drive:readonly docs:document.media:download` | OAuth 权限列表，逗号或空格分隔；未启用的 scope 会在授权时自动跳过 |
| `FEISHU_USER_ACCESS_TOKEN` | 否 | — | 直接使用的用户访问令牌，绕过本地 OAuth 流程 |

## 可用工具

| 工具 | 用途 |
| --- | --- |
| `feishu_auth_status` | 查看凭证配置与授权状态 |
| `feishu_start_readonly_authorization` | 发起 OAuth 授权流程 |
| `feishu_reset_authorization` | 清除已保存的令牌并重新发起授权（切换账号、更新权限等场景） |
| `feishu_read_document` | 读取文档、电子表格、多维表格、思维笔记等内容 |
| `feishu_get_document_image` | 按媒体 Token 获取单张文档图片 |
| `feishu_get_file` | 按文件 Token 获取云盘文件内容 |

### 授权工具

#### `feishu_auth_status`

检查飞书应用是否已配置，以及本地是否存在有效的用户授权。**不会返回任何令牌值**。

参数：无。

#### `feishu_start_readonly_authorization`

启动飞书官方 OAuth 授权流程，返回授权链接、重定向地址和请求的权限列表。授权前会自动过滤应用中未启用的 scope。

参数：无。

#### `feishu_reset_authorization`

清除已保存的用户 OAuth 令牌，并立即发起新的授权流程。适用于切换飞书账号、更新应用权限后重新授权、或授权状态异常需要重置的场景。返回新的授权链接。

参数：无。

### 读取工具

以下工具在未授权时会**自动返回 OAuth 授权链接**，无需提前手动调用授权工具。

#### `feishu_read_document`

读取飞书内容并转换为文本：Docx 文档（文字区块 + 可选内嵌图片）、旧版文档（纯文本）、电子表格（Markdown 表格）、多维表格（记录表格）、思维笔记（大纲）；知识库中的文件节点仅返回元数据，内容用 `feishu_get_file` 获取。

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `source` | string | 必填 | `/wiki/...`、`/docx/...`、`/doc/...`、`/sheets/...`、`/base/...`、`/file/...`、`/mindnotes/...` 链接，或对应 Token |
| `sourceType` | `auto` \| `wiki` \| `docx` \| `doc` \| `sheet` \| `bitable` \| `mindnote` \| `file` | `auto` | `source` 不是链接时用于指定 Token 类型；裸 Token 默认按 Docx 处理 |
| `includeImages` | boolean | `true` | 是否在 MCP 响应中包含文档图片（仅 Docx） |
| `maxImages` | integer | `20` | 单次最多返回的图片数量，取值范围 0～50（仅 Docx） |
| `maxRows` | integer | `500` | 电子表格每个工作表最多渲染的行数，上限 5000 |
| `maxRecords` | integer | `200` | 多维表格每个数据表最多渲染的记录数，上限 1000 |
| `includeRawBlocks` | boolean | `false` | 是否在文字响应末尾附加原始 Docx 区块 JSON（仅 Docx） |

调用示例：

```json
{
  "source": "https://example.feishu.cn/wiki/your_wiki_token",
  "sourceType": "auto",
  "includeImages": true,
  "maxImages": 20,
  "includeRawBlocks": false
}
```

读取电子表格：

```json
{
  "source": "https://example.feishu.cn/sheets/your_spreadsheet_token",
  "maxRows": 500
}
```

#### `feishu_get_document_image`

使用 `feishu_read_document` 返回的图片清单中的媒体 Token，获取单张文档图片。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `token` | string | 图片清单中的媒体 Token |

调用示例：

```json
{
  "token": "image_media_token"
}
```

#### `feishu_get_file`

按文件 Token 获取云盘文件内容：文本类文件（txt、csv、md、json 等）返回文本内容，图片返回 MCP 图片内容，其他二进制文件返回 base64（上限 10 MB）。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `token` | string | 云盘文件 Token，可来自 `feishu_read_document` 对文件节点的返回 |

调用示例：

```json
{
  "token": "your_file_token"
}
```

## 支持范围与限制

**支持**

- 直接读取 Docx、旧版文档、电子表格、多维表格、思维笔记的链接和 Token
- 知识库链接和 Token，自动解析为其底层文档类型（Docx、旧版文档、电子表格、多维表格、思维笔记、云盘文件）
- 常见富文本区块转换为带区块类型标识的可读纯文本
- 云盘文件按类型返回文本 / 图片 / base64

**限制**

- 电子表格每个工作表默认最多渲染 500 行 × 26 列，最多渲染 10 个工作表；多维表格每个数据表默认最多 200 条记录，最多渲染 10 个数据表；均通过 `maxRows` / `maxRecords` 调大
- Docx 内嵌的电子表格、多维表格、文件、画板等区块仅展示元数据，不获取完整内容（如需完整内容请单独读取对应文档）
- `feishu_read_document` 默认最多包含 20 张图片，单次最多可配置为 50 张
- 大于 10 MB 的图片不包含在文档综合响应中，可通过 `feishu_get_document_image` 单独请求
- `feishu_get_file` 返回的文本内容截断至 1 MB，base64 与图片上限 10 MB
- 长文档开启 `includeRawBlocks` 后，可能产生非常大的响应
- 思维笔记读取依赖思维笔记开放接口，需要在应用后台确认对应权限可用

> 所有飞书内容操作均为只读；启动 OAuth 授权时会在本地保存授权信息，详见[令牌存储与安全](#令牌存储与安全)。

## 令牌存储与安全

- 在 macOS 中，OAuth 令牌保存在系统钥匙串中
- 在其他平台中，令牌保存在 `~/.config/feishu-document-mcp/tokens.json`，并设置受限的文件权限
- 授权中间状态保存在 `~/.config/feishu-document-mcp/pending-auth.json`，用于 MCP 进程重启后恢复授权流程
- MCP 工具不会返回应用密钥或访问令牌值
- OAuth 回调服务仅允许使用 `localhost` 或 `127.0.0.1`
- 应仅申请必要的飞书权限，并妥善保管应用密钥
- 如果凭证或令牌可能已经泄露，请及时在飞书开放平台中撤销授权并更换凭证

## 常见问题

### 缺少应用凭证

确认 MCP 服务环境中已经配置 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`，然后重新加载 MCP 客户端。

### 授权页面报错 20043（scope 有误）

授权链接打开后显示「xxx 有误，请修改后重试」，说明请求的某个 scope 未在飞书应用后台启用。当前版本会自动过滤未启用的 scope 并告知用户。如需使用该权限，在飞书应用后台启用并发布后，调用 `feishu_reset_authorization` 重新授权。

### 读取文档时提示无权限

请检查：

- 当前授权用户能否在飞书中打开该文档
- 飞书应用是否已开通所需的只读权限
- 应用是否已发布并安装到对应租户
- 使用租户访问令牌时，目标文档是否已向应用开放

### OAuth 回调失败

确认飞书开放平台中配置的重定向地址与 `FEISHU_OAUTH_REDIRECT_URI` 完全一致，并检查对应本地端口是否已被其他程序占用。

### 端口 3000 被占用

OAuth 回调默认使用 `localhost:3000`。如果该端口被其他程序占用，授权回调将失败。可通过 `lsof -ti :3000 | xargs kill -9` 释放端口，或通过 `FEISHU_OAUTH_REDIRECT_URI` 环境变量指定其他端口（需同步在飞书应用后台添加对应的重定向地址）。

### 知识库节点内容无法读取

服务可以解析知识库节点，并读取底层为 Docx、旧版文档、电子表格、多维表格、思维笔记与云盘文件的内容；其他类型（如幻灯片、画板）暂不支持，会返回明确的错误信息。

### 不支持的文档类型

以下飞书文档类型暂不支持读取：幻灯片（Slides）、画板（Board）、表单（Form）、文件夹。这些是飞书开放平台本身的限制，不提供内容读取 API。

### 读取电子表格或多维表格时提示无权限

确认应用已开通 `sheets:spreadsheet:readonly` 或 `bitable:app:readonly` 权限并发布应用版本，然后重新执行一次 OAuth 授权；旧令牌不会自动获得新权限。

### 无法获取图片

确认应用已开通 `docs:document.media:download` 权限，且 `includeImages` 为 `true`。可以检查返回的图片清单，再通过 `feishu_get_document_image` 获取指定图片。

## 版本与发布

如需了解项目源码、本地开发或贡献代码，请访问 [GitHub 仓库](https://github.com/llhx/feishu-document-mcp-server)。
