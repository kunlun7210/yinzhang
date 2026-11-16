# 印章提取

在线使用：[印章提取](https://kunlun7210.github.io/yinzhang/)

下载仓库后，在 Finder 中打开 `index.html` 也可离线使用。页面启动时会展示一张虚构扫描件。可选择、拖入或粘贴 JPG、PNG 或 WebP 文件，所有图像处理在浏览器本地完成。

- 红章、蓝章可手动切换。自动模式会根据全图或选区内的墨色分布选一种颜色。
- 用「框选区域」限制提取范围。同色印章、标记或文字同时出现时，先圈住需要保留的印章。
- 「浅印保留」控制低色差细节，「印色浓度」控制提取结果的透明度。关闭「去除零散色点」可以保留单像素级细节。
- 勾选「裁掉透明空白」可自动贴近印迹裁切，保留一圈小留白。默认下载透明 PNG，可切换为白底 PNG。

## GitHub Pages

本站通过 GitHub Pages 从 `main` 分支的根目录发布。页面使用相对资源路径，适用于项目站点的子路径。无需安装依赖或运行构建。

[GitHub Pages 发布源配置](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

## 技术取舍

[SealCut](https://github.com/svcvit/SealCut) 使用 Python、Streamlit 和 rembg，先去底再过滤颜色。[Red Seal Extractor](https://github.com/JohnnyChanZY/red-seal-extractor) 展示了颜色分离和实时阈值调节。[Hypho Seal Extractor](https://github.com/Hypho/seal-extractor) 用颜色分离定位红蓝章，另用视觉模型匹配字段。[HS-Restormer](https://github.com/zwwjava/HS-Restormer) 则研究如何处理有复杂背景及重叠印章的文档。

这个 demo 独立实现颜色分离。算法通过目标通道与其他通道的差异估计印色参考值及每像素透明度，再做小范围去噪和裁边。浏览器支持时在 Web Worker 中计算。整图最长边限制为 4096 像素且约 800 万像素以内，超出会等比缩小。优先面向彩色扫描件或背景较干净的照片。暂支持单图中的红色和蓝色印迹，同色内容在空间上重叠时无法可靠分离。
