import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data as string;
}

function createPrompt(
  file: File,
  chunks: Chunk[],
  prDetails: PRDetails
): string {
  const combinedChunks = chunks
    .map(
      (chunk) => `
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}`
    )
    .join("\n");

  return `
    Você é um Engenheiro de Software experiente e deve revisar um pull request para garantir código limpo, eficiente e seguindo boas práticas. Analise:

    1. Qualidade: Verifique manutenibilidade e clareza. Simplifique onde possível.
    2. Lógica: Confirme a funcionalidade e identifique erros ou casos extremos.
    3. Desempenho: Sugira melhorias de uso de recursos e execução.
    4. Segurança: Identifique vulnerabilidades.
    5. Testes: Avalie cobertura e eficácia. Sugira testes adicionais, se necessário.
    6. Documentação: Verifique se está clara e precisa, mas não sugira adicionar comentários no código.

    Formato da resposta: JSON no formato {"reviews": [{"lineNumber": "<número>", "reviewComment": "<comentário>"}]}. Só forneça sugestões de melhoria e comente uma vez por problema. Se não houver melhorias, deixe "reviews" vazio.

    Instruções:
    - Comente apenas arquivos de código, ignore configurações (.json, .yaml, .yml, .properties).
    - Feedback construtivo e específico, em português do Brasil.

    Revise o seguinte diff de código no arquivo "${file.to}" e considere o título e a descrição do pull request ao escrever a resposta.

    Título do pull request: ${prDetails.title}
    Descrição do pull request:

    ---
    ${prDetails.description}
    ---

    Git diff para revisão:

\`\`\`diff
${combinedChunks}
\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      messages: [{ role: "user", content: prompt }],
    });

    const res = response.choices[0].message?.content?.trim() || "{}";
    return JSON.parse(res).reviews;
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    const chunks = file.chunks;
    const prompt = createPrompt(file, chunks, prDetails);
    const aiResponse = await getAIResponse(prompt);

    if (aiResponse) {
      const newComments = aiResponse.map((aiComment) => ({
        body: aiComment.reviewComment,
        path: file.to!,
        line: Number(aiComment.lineNumber),
      }));
      comments.push(...newComments);
    }
  }
  return comments;
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  if (eventData.action === "opened" || eventData.action === "synchronize") {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
