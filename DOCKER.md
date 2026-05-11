# Docker 部署 Server

这个 Docker 只运行 `server`，不包含本地监听 `agent`。

## 构建并启动

```bash
docker compose up -d --build
```

启动后：

```text
http://服务器IP:50001
```

本地 Windows 上的 agent 连接这个地址即可，例如：

```powershell
npm run dev:agent -- --dir "C:\Users\wenxiang\Desktop" --server "http://服务器IP:50001"
```

## 数据目录

`docker-compose.yml` 默认挂载：

```text
./docker-data/files  -> /data/md-pdf/files
./docker-data/state  -> /app/.md-pdf-server
```

- `files`：Markdown 和 asset 图片存储目录
- `state`：置顶状态、PDF 缓存等服务端状态

备份服务器数据时，备份 `docker-data` 目录即可。

## 查看日志

```bash
docker logs -f md-pdf-server
```

## 停止服务

```bash
docker compose down
```
