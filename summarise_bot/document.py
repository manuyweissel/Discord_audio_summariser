from __future__ import annotations

from datetime import datetime
from io import BytesIO

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Pt


def convert_to_word_doc(content: str, meeting_title: str = "Meeting") -> bytes | None:
    try:
        doc = Document()
        title = doc.add_paragraph()
        title.style = doc.styles["Title"]
        title.alignment = WD_ALIGN_PARAGRAPH.LEFT
        title_run = title.add_run("Meeting Minutes")
        title_run.font.size = Pt(22)
        subtitle = doc.add_paragraph(f"{meeting_title} • {datetime.now().strftime('%d.%m.%Y')}")
        subtitle.alignment = WD_ALIGN_PARAGRAPH.LEFT

        table_rows: list[list[str]] = []
        in_table = False
        for raw_line in content.splitlines():
            line = raw_line.strip()
            if not line:
                if in_table and table_rows:
                    _append_table(doc, table_rows)
                    table_rows = []
                    in_table = False
                continue

            if line.startswith("## "):
                if in_table and table_rows:
                    _append_table(doc, table_rows)
                    table_rows = []
                    in_table = False
                doc.add_heading(line.replace("## ", "").strip(), level=1)
                continue

            if line.startswith("### "):
                if in_table and table_rows:
                    _append_table(doc, table_rows)
                    table_rows = []
                    in_table = False
                doc.add_heading(line.replace("### ", "").strip(), level=2)
                continue

            if "|" in line:
                cells = [cell.strip() for cell in line.split("|") if cell.strip()]
                if cells and not set(cells[0]) <= {"-"}:
                    table_rows.append(cells)
                    in_table = True
                continue

            paragraph = doc.add_paragraph()
            if line.startswith(("- ", "* ")):
                paragraph.style = "List Bullet"
                paragraph.add_run(line[2:].strip())
            else:
                paragraph.add_run(line)

        if in_table and table_rows:
            _append_table(doc, table_rows)

        footer = doc.add_paragraph()
        footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
        footer.add_run(f"Generated automatically • {datetime.now().strftime('%d.%m.%Y %H:%M')}")

        output = BytesIO()
        doc.save(output)
        return output.getvalue()
    except Exception:
        return None


def _append_table(doc: Document, rows: list[list[str]]) -> None:
    if not rows:
        return
    width = max(len(row) for row in rows)
    table = doc.add_table(rows=1, cols=width)
    table.style = "Table Grid"
    header_cells = table.rows[0].cells
    for idx, value in enumerate(rows[0]):
        header_cells[idx].text = value
    for row_values in rows[1:]:
        cells = table.add_row().cells
        for idx, value in enumerate(row_values):
            cells[idx].text = value
