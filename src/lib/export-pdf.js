import { stages, itemLines } from "../../shared/assessment.js";

export async function downloadAssessmentPdf(approved, which) {
  const { jsPDF } = await import("jspdf");
  const trainer = which === "trainer";
  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const left = 18;
  const right = 18;
  const maxWidth = pageWidth - left - right;
  let y = 22;
  const ensure = (height) => {
    if (y + height > pageHeight - 18) {
      pdf.addPage();
      y = 20;
    }
  };
  const write = (
    text,
    size = 10,
    font = "normal",
    color = [24, 36, 51],
    gap = 5,
  ) => {
    pdf.setFont("helvetica", font);
    pdf.setFontSize(size);
    pdf.setTextColor(...color);
    const wrapped = pdf.splitTextToSize(String(text), maxWidth);
    wrapped.forEach((line) => {
      ensure(gap + 1);
      pdf.text(line, left, y);
      y += gap;
    });
    y += 2;
  };
  pdf.setFillColor(36, 87, 214);
  pdf.rect(0, 0, pageWidth, 11, "F");
  write(
    trainer
      ? "QUESTION STUDIO  /  TRAINER EDITION"
      : "QUESTION STUDIO  /  STUDENT EDITION",
    8,
    "bold",
    [36, 87, 214],
    4,
  );
  write("Assessment questions", 22, "normal", [24, 36, 51], 9);
  y += 2;
  stages.forEach((step) => {
    ensure(14);
    pdf.setDrawColor(220, 227, 237);
    pdf.line(left, y, pageWidth - right, y);
    y += 7;
    write(step.label.toUpperCase(), 9, "bold", [141, 84, 39], 5);
    (approved[step.id] || []).forEach((item, index) => {
      const content = itemLines(item, index, step.id, trainer);
      content.forEach((line, lineIndex) =>
        write(
          line,
          lineIndex === 0 ? 11 : 9,
          lineIndex === 0 ? "bold" : "normal",
          line.startsWith("Answer:") ? [36, 87, 214] : [24, 36, 51],
          5,
        ),
      );
      y += 3;
    });
  });
  pdf.save(
    trainer ? "assessment-trainer-copy.pdf" : "assessment-student-copy.pdf",
  );
}
