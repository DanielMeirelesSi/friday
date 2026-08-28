import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { execSync } from "node:child_process";
import * as ts from "typescript";

const program = new Command();

type ItemEstrutura = {
  linha: number;
  tipo: "funcao" | "arrow" | "classe" | "metodo";
  nome: string;
  parametros?: string[];
  classe?: string;
};

program
  .name("friday")
  .description("Assistente de desenvolvimento pela linha de comando")
  .version("1.0.0");

const extensoesComAst = new Set([".ts", ".tsx", ".js", ".jsx"]);
const pastasIgnoradas = new Set(["node_modules", ".git", "dist"]);

function arquivoSuportado(arquivo: string) {
  return extensoesComAst.has(extname(arquivo).toLowerCase());
}

function obterScriptKind(extensao: string) {
  switch (extensao) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
      return ts.ScriptKind.JS;
    case ".ts":
    default:
      return ts.ScriptKind.TS;
  }
}

function nomeDeclaracao(
  nome: ts.Identifier | undefined,
  fallback: string
) {
  return nome?.text || fallback;
}

function parametrosDaFuncao(
  parametros: ts.NodeArray<ts.ParameterDeclaration>,
  sourceFile: ts.SourceFile
) {
  return parametros.map((parametro) => parametro.name.getText(sourceFile));
}

function arrowDeInicializador(
  inicializador: ts.Expression | undefined
): ts.ArrowFunction | undefined {
  let atual = inicializador;

  while (atual) {
    if (ts.isArrowFunction(atual)) {
      return atual;
    }

    if (
      ts.isParenthesizedExpression(atual) ||
      ts.isAsExpression(atual) ||
      ts.isTypeAssertionExpression(atual) ||
      ts.isNonNullExpression(atual) ||
      ts.isSatisfiesExpression(atual)
    ) {
      atual = atual.expression;
      continue;
    }

    return undefined;
  }

  return undefined;
}

function nomeMembroClasse(nome: ts.PropertyName, sourceFile: ts.SourceFile) {
  if (ts.isPrivateIdentifier(nome)) {
    return nome.text;
  }

  return nome.getText(sourceFile);
}

function temErroDeParse(sourceFile: ts.SourceFile) {
  const diagnosticos =
    (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
      .parseDiagnostics ?? [];

  return diagnosticos.length > 0;
}

function extrairDoSourceFile(sourceFile: ts.SourceFile) {
  const encontrados: (ItemEstrutura & { ordem: number })[] = [];

  const linhaInicial = (node: ts.Node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const adicionar = (item: ItemEstrutura) => {
    encontrados.push({ ...item, ordem: encontrados.length });
  };

  const visitar = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node)) {
      adicionar({
        linha: linhaInicial(node),
        tipo: "funcao",
        nome: nomeDeclaracao(node.name, "(anonima)"),
        parametros: parametrosDaFuncao(node.parameters, sourceFile),
      });
    }

    if (ts.isVariableDeclaration(node)) {
      const arrow = arrowDeInicializador(node.initializer);
      if (arrow) {
        adicionar({
          linha: linhaInicial(node),
          tipo: "arrow",
          nome: node.name.getText(sourceFile),
          parametros: parametrosDaFuncao(arrow.parameters, sourceFile),
        });
      }
    }

    if (ts.isClassDeclaration(node)) {
      const nomeClasse = nomeDeclaracao(node.name, "(anonima)");
      adicionar({
        linha: linhaInicial(node),
        tipo: "classe",
        nome: nomeClasse,
      });

      node.members.forEach((membro) => {
        if (
          ts.isMethodDeclaration(membro) ||
          ts.isGetAccessorDeclaration(membro) ||
          ts.isSetAccessorDeclaration(membro)
        ) {
          adicionar({
            linha: linhaInicial(membro),
            tipo: "metodo",
            nome: nomeMembroClasse(membro.name, sourceFile),
            classe: nomeClasse,
            parametros: parametrosDaFuncao(membro.parameters, sourceFile),
          });
        }

        if (ts.isConstructorDeclaration(membro)) {
          adicionar({
            linha: linhaInicial(membro),
            tipo: "metodo",
            nome: "constructor",
            classe: nomeClasse,
            parametros: parametrosDaFuncao(membro.parameters, sourceFile),
          });
        }
      });
    }

    ts.forEachChild(node, visitar);
  };

  visitar(sourceFile);

  return encontrados
    .sort((a, b) => a.linha - b.linha || a.ordem - b.ordem)
    .map(({ ordem, ...item }) => item);
}

function extrairEstrutura(conteudo: string, arquivo: string) {
  if (!conteudo.trim()) {
    return [];
  }

  const extensao = extname(arquivo).toLowerCase();
  if (!arquivoSuportado(arquivo)) {
    return [];
  }

  try {
    const sourceFile = ts.createSourceFile(
      arquivo,
      conteudo,
      ts.ScriptTarget.Latest,
      true,
      obterScriptKind(extensao)
    );

    if (temErroDeParse(sourceFile)) {
      return [];
    }

    return extrairDoSourceFile(sourceFile);
  } catch {
    return [];
  }
}

function encontrarArquivosDeCodigo(pasta: string): string[] {
  const encontrados: string[] = [];

  const visitar = (pastaAtual: string) => {
    const entradas = readdirSync(pastaAtual, { withFileTypes: true });

    entradas.forEach((entrada) => {
      const caminho = join(pastaAtual, entrada.name);

      if (entrada.isDirectory()) {
        if (!pastasIgnoradas.has(entrada.name)) {
          visitar(caminho);
        }

        return;
      }

      if (entrada.isFile() && arquivoSuportado(caminho)) {
        encontrados.push(caminho);
      }
    });
  };

  visitar(pasta);

  return encontrados;
}

function documentarArquivo(arquivo: string) {
  const conteudo = readFileSync(arquivo, "utf-8");
  const estrutura = extrairEstrutura(conteudo, arquivo);

  console.log(`FRIDAY: analisei ${basename(arquivo)}, encontrei ${estrutura.length} elemento(s).`);
  console.log("FRIDAY: pedindo ao Codex para redigir a documentacao. Isso pode levar alguns segundos...");

  const prompt = montarPrompt(arquivo, conteudo, estrutura);
  const documentacao = chamarCodex(prompt);

  const nomeSaida = basename(arquivo) + ".md";
  const caminhoSaida = join(dirname(arquivo), nomeSaida);
  writeFileSync(caminhoSaida, documentacao, "utf-8");

  console.log(`FRIDAY: documentacao salva em ${caminhoSaida}`);
}

function montarPrompt(
  arquivo: string,
  conteudo: string,
  estrutura: ItemEstrutura[]
) {
  const listaEstrutura = estrutura
    .map((item) => {
      const escopo = item.tipo === "metodo" && item.classe ? `${item.classe}.` : "";
      const parametros =
        item.tipo === "classe" ? "" : `(${(item.parametros ?? []).join(", ")})`;

      return `- ${item.tipo} ${escopo}${item.nome}${parametros} (linha ${item.linha})`;
    })
    .join("\n");

  return [
    "Voce e um redator tecnico. Escreva a documentacao do arquivo abaixo.",
    "Eu ja analisei o arquivo e extrai a estrutura. Use ela como guia.",
    "",
    `Arquivo: ${basename(arquivo)}`,
    "",
    "Estrutura extraida:",
    listaEstrutura || "(nenhum elemento estrutural encontrado)",
    "",
    "Codigo completo:",
    "```",
    conteudo,
    "```",
    "",
    "Regras da documentacao:",
    "- Escreva em portugues correto e com acentuacao.",
    "- Nao use travessao.",
    "- Explique o proposito do arquivo, o que cada funcao ou classe faz, e como usar.",
    "- Inclua um exemplo de uso real quando fizer sentido.",
    "- Seja direto, sem enrolacao nem linguagem generica.",
    "- Responda apenas com a documentacao em markdown, sem comentarios extras.",
  ].join("\n");
}

function chamarCodex(prompt: string): string {
  const saidaBruta = execSync("codex exec -", {
    input: prompt,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 10,
  });

  const linhas = saidaBruta.split("\n");

  let inicio = -1;
  for (let i = linhas.length - 1; i >= 0; i--) {
    if (linhas[i].trim() === "codex") {
      inicio = i + 1;
      break;
    }
  }

  if (inicio === -1) {
    return saidaBruta.trim();
  }

  let fim = linhas.length;
  for (let i = inicio; i < linhas.length; i++) {
    if (linhas[i].trim() === "tokens used") {
      fim = i;
      break;
    }
  }

  return linhas.slice(inicio, fim).join("\n").trim();
}

program
  .command("doc")
  .description("Gera documentacao tecnica do projeto")
  .argument("<caminho>", "caminho do arquivo ou pasta a documentar")
  .action((caminho: string) => {
    if (!existsSync(caminho)) {
      console.log(`FRIDAY: nao encontrei o caminho "${caminho}". Confira o caminho.`);
      return;
    }

    const estatisticas = statSync(caminho);

    if (estatisticas.isFile()) {
      documentarArquivo(caminho);
      return;
    }

    if (!estatisticas.isDirectory()) {
      console.log(`FRIDAY: o caminho "${caminho}" nao e um arquivo nem uma pasta.`);
      return;
    }

    const arquivos = encontrarArquivosDeCodigo(caminho);

    if (arquivos.length === 0) {
      console.log(`FRIDAY: nao encontrei arquivos .ts, .tsx, .js ou .jsx em "${caminho}".`);
      return;
    }

    let documentados = 0;

    arquivos.forEach((arquivo, indice) => {
      console.log(`FRIDAY: [${indice + 1}/${arquivos.length}] documentando ${basename(arquivo)}`);

      try {
        documentarArquivo(arquivo);
        documentados++;
      } catch (erro) {
        const mensagem = erro instanceof Error ? erro.message : String(erro);
        console.log(`FRIDAY: falhei ao documentar ${arquivo}: ${mensagem}`);
      }
    });

    console.log(`FRIDAY: documentacao concluida. ${documentados}/${arquivos.length} arquivo(s) documentado(s).`);
  });

program.parse();
