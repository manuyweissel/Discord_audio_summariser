import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  BorderStyle
} from 'docx';

/**
 * Convert markdown content to a Word document buffer
 * @param {string} content - Markdown content
 * @param {string} meetingTitle - Meeting title
 * @returns {Promise<Buffer|null>} Word document buffer or null
 */
export async function convertToWordDoc(content, meetingTitle = "Meeting") {
  try {
    const currentDate = new Date().toLocaleDateString('de-DE');
    const timestamp = new Date().toLocaleString('de-DE');

    const lines = content.split('\n');
    const docElements = [];

    // Document title
    docElements.push(
      new Paragraph({
        children: [
          new TextRun({
            text: "Meeting Minutes",
            bold: true,
            size: 28,
            color: "1E40AF"
          })
        ],
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.LEFT,
        spacing: { after: 200 }
      }),
      new Paragraph({
        children: [
          new TextRun({
            text: `${meetingTitle} • ${currentDate}`,
            size: 18,
            color: "64748B"
          })
        ],
        alignment: AlignmentType.LEFT,
        spacing: { after: 400 }
      })
    );

    // Process content
    let inTable = false;
    let tableRows = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('##')) {
        // Finish any open table
        if (inTable && tableRows.length > 0) {
          docElements.push(createWordTable(tableRows));
          tableRows = [];
          inTable = false;
        }

        // Section heading
        const headingText = line.replace(/^##\s*/, '').replace(/\*\*/g, '').replace(/🏢|👥|🎯|📊|📝|🗓️|⚠️|📋/g, '').trim();
        docElements.push(
          new Paragraph({
            children: [
              new TextRun({
                text: headingText,
                bold: true,
                size: 20,
                color: "1E40AF"
              })
            ],
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 300, after: 150 }
          })
        );
      } else if (line.startsWith('###')) {
        // Subsection heading
        const headingText = line.replace(/^###\s*/, '').replace(/\*\*/g, '').replace(/🏢|👥|🎯|📊|📝|🗓️|⚠️|📋/g, '').trim();
        docElements.push(
          new Paragraph({
            children: [
              new TextRun({
                text: headingText,
                bold: true,
                size: 16,
                color: "1E293B"
              })
            ],
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 200, after: 100 }
          })
        );
      } else if (line.includes('|') && line.includes('-')) {
        // Table header separator - start table
        inTable = true;
      } else if (line.includes('|') && inTable) {
        // Table row
        const cells = line.split('|').map(cell => cell.trim()).filter(cell => cell);
        if (cells.length > 0) {
          tableRows.push(cells);
        }
      } else if (line.includes('|') && !inTable) {
        // Simple table row (start new table)
        const cells = line.split('|').map(cell => cell.trim()).filter(cell => cell);
        if (cells.length > 0) {
          tableRows = [cells];
          inTable = true;
        }
      } else if (line && !inTable) {
        // Regular paragraph
        if (line.startsWith('- ') || line.startsWith('* ')) {
          // Bullet point
          const bulletText = line.replace(/^[-*]\s*/, '').replace(/\*\*/g, '').replace(/🏢|👥|🎯|📊|📝|🗓️|⚠️|📋|✅|❌|🟢|🟡|🔴|⚪|🔥/g, '').trim();
          docElements.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: `• ${bulletText}`,
                  size: 20,
                  color: "1E293B"
                })
              ],
              spacing: { after: 80 }
            })
          );
        } else if (line.startsWith('>')) {
          // Quote/Note
          const quoteText = line.replace(/^>\s*/, '').replace(/\*\*/g, '');
          docElements.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: quoteText,
                  italic: true,
                  size: 20,
                  color: "6B7280"
                })
              ],
              spacing: { after: 150 }
            })
          );
        } else if (line.length > 0 && !line.startsWith('<') && !line.includes('<!--')) {
          // Regular text
          const cleanText = line.replace(/\*\*/g, '').replace(/📋|📅|👥|🎯|📊|⚠️|✅|❌|🟢|🟡|🔴|⚪|🔥/g, '').trim();
          if (cleanText.trim()) {
            docElements.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: cleanText,
                    size: 20,
                    color: "1E293B"
                  })
                ],
                spacing: { after: 100 }
              })
            );
          }
        }
      } else if (!line && inTable && tableRows.length > 0) {
        // End of table
        docElements.push(createWordTable(tableRows));
        tableRows = [];
        inTable = false;
      }
    }

    // Handle any remaining table
    if (inTable && tableRows.length > 0) {
      docElements.push(createWordTable(tableRows));
    }

    // Footer
    docElements.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `Generated automatically • ${timestamp}`,
            size: 16,
            color: "64748B",
            italics: true
          })
        ],
        alignment: AlignmentType.CENTER,
        spacing: { before: 400 }
      })
    );

    // Create document
    const doc = new Document({
      sections: [{
        children: docElements,
        properties: {
          page: {
            margin: {
              top: 1440,    // 1 inch
              right: 1440,
              bottom: 1440,
              left: 1440,
            },
          },
        },
      }],
    });

    return await Packer.toBuffer(doc);
  } catch (error) {
    console.error('Failed to convert to Word:', error);
    return null;
  }
}

/**
 * Create a Word table from rows data
 */
function createWordTable(rows) {
  if (!rows || rows.length === 0) return new Paragraph({ children: [] });

  const tableRows = rows.map((row, index) => {
    const cells = row.map(cellText => {
      const cleanText = cellText.replace(/\*\*/g, '').replace(/🟢|🟡|🔴|⚪|🔥|📋|📅|👥|🎯|📊|⚠️|✅|❌/g, '').trim();

      return new TableCell({
        children: [
          new Paragraph({
            children: [
              new TextRun({
                text: cleanText,
                bold: index === 0,
                size: index === 0 ? 18 : 16,
                color: index === 0 ? "FFFFFF" : "1E293B"
              })
            ],
            alignment: AlignmentType.LEFT
          })
        ],
        shading: {
          fill: index === 0 ? "1E40AF" : (index % 2 === 0 ? "F8FAFC" : "FFFFFF")
        },
        margins: {
          top: 200,
          bottom: 200,
          left: 300,
          right: 300,
        }
      });
    });

    return new TableRow({
      children: cells
    });
  });

  return new Table({
    rows: tableRows,
    width: {
      size: 100,
      type: WidthType.PERCENTAGE,
    },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 1, color: "E2E8F0" },
      bottom: { style: BorderStyle.SINGLE, size: 1, color: "E2E8F0" },
      left: { style: BorderStyle.SINGLE, size: 1, color: "E2E8F0" },
      right: { style: BorderStyle.SINGLE, size: 1, color: "E2E8F0" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: "E2E8F0" },
      insideVertical: { style: BorderStyle.SINGLE, size: 1, color: "E2E8F0" },
    },
  });
}
