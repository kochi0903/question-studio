export const stages = [
  {
    id: "mcq",
    label: "Multiple choice",
    sub: "5 candidates · choose 2",
    target: 2,
    total: 5,
  },
  {
    id: "truefalse",
    label: "True or false",
    sub: "5 candidates · choose 2",
    target: 2,
    total: 5,
  },
  {
    id: "coding",
    label: "Code analysis",
    sub: "3 candidates · choose 1",
    target: 1,
    total: 3,
  },
];

const text = (value) => typeof value === "string" && value.trim().length > 0;

function canonicalSourceText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/```(?:[\w+-]+)?\s*([\s\S]*?)```/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

function evidenceWords(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[’‘]/g, "'")
    .match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu)
    ?.map((word) => word.toLowerCase()) || [];
}

function normalizeEvidenceWord(value) {
  return value.normalize("NFKC").replace(/[’‘]/g, "'").toLowerCase();
}

function sourceEvidence(evidence, sourceText) {
  const canonicalSource = canonicalSourceText(sourceText);
  const sourceMatches = [
    ...canonicalSource.matchAll(/[\p{L}\p{N}]+(?:['’‘][\p{L}\p{N}]+)*/gu),
  ];
  const expected = evidenceWords(evidence);
  if (!expected.length || expected.length > sourceMatches.length) return "";

  for (let start = 0; start <= sourceMatches.length - expected.length; start++) {
    const matches = expected.every(
      (word, offset) =>
        normalizeEvidenceWord(sourceMatches[start + offset][0]) === word,
    );
    if (!matches) continue;
    const first = sourceMatches[start].index;
    const last = sourceMatches[start + expected.length - 1];
    return canonicalSource.slice(first, last.index + last[0].length);
  }
  return "";
}

// Used for model output and reviewer edits, so approval cannot bypass validation.
export function validateQuestion(item, type, sourceText) {
  const fail = (message) => {
    throw new Error(message);
  };
  if (!stages.some((stage) => stage.id === type))
    fail("Unknown question category.");
  if (!item || typeof item !== "object" || Array.isArray(item))
    fail("Question must be an object.");
  if (!["Easy", "Medium", "Hard"].includes(item.difficulty))
    fail("Choose Easy, Medium, or Hard difficulty.");
  if (
    !Array.isArray(item.topics) ||
    !item.topics.length ||
    !item.topics.every(text)
  )
    fail("Add at least one nonempty topic.");
  if (!text(item.explanation)) fail("Add a trainer explanation.");
  const evidence = sourceEvidence(item.evidence, sourceText);
  if (!text(item.evidence) || !evidence)
    fail("Evidence must match a passage in the source.");
  const common = {
    difficulty: item.difficulty,
    topics: [...new Set(item.topics.map((topic) => topic.trim()))],
    explanation: item.explanation.trim(),
    evidence,
  };
  if (type === "mcq") {
    if (
      !text(item.stem) ||
      !Array.isArray(item.options) ||
      item.options.length !== 4 ||
      !item.options.every(text)
    )
      fail("MCQs need a question and four nonempty options.");
    if (
      new Set(item.options.map((option) => option.trim().toLowerCase()))
        .size !== 4
    )
      fail("MCQ options must be distinct.");
    if (
      typeof item.correctAnswer !== "string" ||
      !/^[A-D]$/i.test(item.correctAnswer.trim())
    )
      fail("The MCQ answer must be A, B, C, or D.");
    return {
      ...common,
      stem: item.stem.trim(),
      options: item.options.map((option) => option.trim()),
      correctAnswer: item.correctAnswer.trim().toUpperCase(),
    };
  }
  if (type === "truefalse") {
    if (!text(item.statement) || typeof item.correctAnswer !== "boolean")
      fail("True/false questions need a statement and a boolean answer.");
    return {
      ...common,
      statement: item.statement.trim(),
      correctAnswer: item.correctAnswer,
    };
  }
  if (![item.codeSnippet, item.task, item.expectedAnswer].every(text))
    fail("Code analysis needs code, a task, and an expected answer.");
  return {
    ...common,
    title: text(item.title) ? item.title.trim() : "Code analysis",
    codeSnippet: item.codeSnippet,
    task: item.task.trim(),
    expectedAnswer: item.expectedAnswer.trim(),
  };
}

export function itemLines(item, index, type, trainer) {
  const prefix = `${index + 1}. `;
  const lines =
    type === "mcq"
      ? [
          prefix + item.stem,
          ...item.options.map(
            (option, i) => `   ${String.fromCharCode(65 + i)}) ${option}`,
          ),
        ]
      : type === "truefalse"
        ? [prefix + item.statement]
        : [
            prefix + (item.title || "Code analysis"),
            item.codeSnippet,
            "Task: " + item.task,
          ];
  lines.push(
    `Difficulty: ${item.difficulty}  |  Topics: ${item.topics.join(", ")}`,
  );
  if (trainer)
    lines.push(
      "Answer: " +
        (type === "truefalse"
          ? item.correctAnswer
            ? "True"
            : "False"
          : type === "mcq"
            ? item.correctAnswer
            : item.expectedAnswer),
      "Explanation: " + item.explanation,
      "Source link: " + item.evidence,
    );
  return lines;
}

export function formattedCopy(approved, trainer) {
  const rows = [
    trainer ? "TRAINER COPY — ANSWERS INCLUDED" : "STUDENT COPY",
    "Assessment questions",
    "",
  ];
  stages.forEach((stage) => {
    rows.push(stage.label.toUpperCase());
    (approved[stage.id] || []).forEach((item, index) =>
      rows.push(...itemLines(item, index, stage.id, trainer), ""),
    );
    rows.push("");
  });
  return rows.join("\n");
}
