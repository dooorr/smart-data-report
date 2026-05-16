# docs 目录说明

本目录下的 **`thesis_figures/`**、**`thesis_pandoc_reference.docx`** 与仓库根目录的 **`thesis_draft.md`** 为个人撰写存档用（非主 README 所描述的课程交付物）。需要自行导出 Word 时，在 **`<Project_Root>`** 执行（输出文件名可按需修改，勿将含学号/姓名的路径提交到公开仓库）：

**Windows（PowerShell）**

```powershell
Set-Location <Project_Root>
pandoc thesis_draft.md -o thesis.docx --reference-doc=docs/thesis_pandoc_reference.docx --resource-path=".;docs"
```

**Linux / macOS**

```bash
cd <Project_Root>
pandoc thesis_draft.md -o thesis.docx --reference-doc=docs/thesis_pandoc_reference.docx --resource-path=".:docs"
```

生成前请关闭已打开的输出 Word；需本机已安装 [Pandoc](https://pandoc.org/)。常见导出文件名已列入仓库根目录 `.gitignore`，避免误提交。
