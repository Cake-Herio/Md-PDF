# Md-PDF

多系统之间同步 MD/PDF 文件，可手机端在线阅览。

当前版本是本地试验版 Markdown 阅读程序：

- 启动时输入 Markdown 文件夹路径
- 自动扫描并监听 `.md` 文件变化
- 在本机启动一个手机可访问的阅读页面
- 点击文件后由本机 Edge/Chrome 生成 PDF，适合 iPhone 阅读

## 使用

```powershell
npm install
npm run dev
```

也可以直接指定目录和端口：

```powershell
npm run dev -- --dir "C:\Users\wenxiang\Desktop" --port 3333
```

启动后，电脑浏览器或 iPhone Safari 打开程序输出的地址即可。

如果手机和电脑在同一个 Wi-Fi，优先用类似 `http://192.168.x.x:3333` 的地址。

## 双击启动

可以直接双击：

```text
release\local-md-reader.cmd
```

它会打开命令行窗口，并提示输入要监听的 Markdown 文件夹路径。

## PDF 说明

程序会调用本机已安装的 Microsoft Edge 或 Chrome 的 headless print 功能生成 PDF。

如果自动找不到浏览器，可以设置环境变量：

```powershell
$env:BROWSER_PATH = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
npm run dev
```
