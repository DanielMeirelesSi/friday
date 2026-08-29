import { Command } from "commander";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import * as ts from "typescript";
import { parse as parseYaml } from "yaml";

const program = new Command();

type ItemEstrutura = {
  linha: number;
  tipo: "funcao" | "arrow" | "classe" | "metodo";
  nome: string;
  parametros?: string[];
  classe?: string;
};

type ResultadoCheck = {
  comando: string;
  passou: boolean;
  codigoSaida: number | null;
  saida: string;
};

type MudancasGit = {
  diff: string;
  arquivos: string[];
};

type RelatorioVerify = {
  timestamp: string;
  branch: string;
  arquivosAlterados: string[];
  checks: ResultadoCheck[];
  revisao: string;
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

function lerChecksConfigurados(raiz: string) {
  const caminhoConfig = join(raiz, "friday.yml");

  if (!existsSync(caminhoConfig)) {
    return [];
  }

  try {
    const configuracao = parseYaml(readFileSync(caminhoConfig, "utf-8")) as
      | { checks?: unknown }
      | null;
    const checks = configuracao?.checks;

    if (!Array.isArray(checks)) {
      return [];
    }

    return checks
      .filter((check): check is string => typeof check === "string" && check.trim().length > 0)
      .map((check) => check.trim());
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    console.log(`FRIDAY: nao consegui ler friday.yml (${mensagem}). Vou seguir sem checks.`);
    return [];
  }
}

function rodarProcesso(comando: string, args: string[], cwd: string) {
  const resultado = spawnSync(comando, args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 10,
    windowsHide: true,
  });

  return {
    codigoSaida: resultado.status,
    stdout: resultado.stdout ?? "",
    stderr: resultado.stderr ?? "",
    erro: resultado.error?.message,
  };
}

function rodarCheck(comando: string, cwd: string): ResultadoCheck {
  const resultado = spawnSync(comando, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 10,
    shell: true,
    windowsHide: true,
  });
  const stdout = resultado.stdout ?? "";
  const stderr = resultado.stderr ?? "";
  const erro = resultado.error?.message;
  const saida = [stdout, stderr, erro ? `Erro ao executar: ${erro}` : ""]
    .filter((parte) => parte.trim().length > 0)
    .join("\n");

  return {
    comando,
    passou: resultado.status === 0 && !resultado.error,
    codigoSaida: resultado.status,
    saida,
  };
}

function dentroDeRepositorioGit(raiz: string) {
  const resultado = rodarProcesso("git", ["rev-parse", "--is-inside-work-tree"], raiz);
  return resultado.codigoSaida === 0 && resultado.stdout.trim() === "true";
}

function obterBranchAtual(raiz: string) {
  const resultado = rodarProcesso("git", ["rev-parse", "--abbrev-ref", "HEAD"], raiz);

  if (resultado.codigoSaida !== 0) {
    return "(desconhecida)";
  }

  return resultado.stdout.trim() || "(desconhecida)";
}

function separarArquivosGit(saida: string) {
  return saida.split("\0").filter((arquivo) => arquivo.length > 0);
}

function capturarMudancasGit(raiz: string): MudancasGit | undefined {
  const head = rodarProcesso("git", ["rev-parse", "--verify", "HEAD"], raiz);
  const base = head.codigoSaida === 0 ? "HEAD" : "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const diff = rodarProcesso("git", ["diff", "--no-ext-diff", "--no-color", base, "--"], raiz);
  const arquivos = rodarProcesso("git", ["diff", "--name-only", "-z", base, "--"], raiz);
  const arquivosNovos = rodarProcesso("git", ["ls-files", "--others", "--exclude-standard", "-z"], raiz);

  if (diff.codigoSaida !== 0 || arquivos.codigoSaida !== 0 || arquivosNovos.codigoSaida !== 0) {
    return undefined;
  }

  const arquivosRastreados = separarArquivosGit(arquivos.stdout);
  const arquivosNaoRastreados = separarArquivosGit(arquivosNovos.stdout);
  const diffsArquivosNovos = arquivosNaoRastreados.map((arquivo) => {
    try {
      const conteudo = readFileSync(join(raiz, arquivo), "utf-8");
      const linhas =
        conteudo.length === 0 ? [] : conteudo.replace(/\r?\n$/, "").split(/\r?\n/);

      return [
        `diff --git a/${arquivo} b/${arquivo}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${arquivo}`,
        "@@ arquivo novo nao rastreado @@",
        ...linhas.map((linha) => `+${linha}`),
      ].join("\n");
    } catch (erro) {
      const mensagem = erro instanceof Error ? erro.message : String(erro);

      return [
        `diff --git a/${arquivo} b/${arquivo}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${arquivo}`,
        "@@ arquivo novo nao rastreado @@",
        `+FRIDAY: nao consegui ler o conteudo deste arquivo novo (${mensagem}).`,
      ].join("\n");
    }
  });

  return {
    diff: [diff.stdout, ...diffsArquivosNovos]
      .filter((parte) => parte.trim().length > 0)
      .join("\n"),
    arquivos: [...new Set([...arquivosRastreados, ...arquivosNaoRastreados])],
  };
}

function montarPromptVerify(diff: string, checks: ResultadoCheck[]) {
  const limitarSaida = (saida: string) =>
    saida.length > 2000 ? saida.slice(-2000) : saida;
  const resumoChecks =
    checks.length === 0
      ? "(nenhum check configurado)"
      : checks
          .map((check) => `- ${check.passou ? "passou" : "falhou"}: ${check.comando}`)
          .join("\n");
  const saidasChecksFalhos = checks
    .filter((check) => !check.passou && check.saida.trim().length > 0)
    .map((check) =>
      [
        `Check: ${check.comando}`,
        "Saida capturada:",
        "```",
        limitarSaida(check.saida),
        "```",
      ].join("\n")
    )
    .join("\n\n");

  return [
    "Voce e um revisor tecnico. Revise apenas o diff abaixo.",
    "Aponte problemas reais: bugs, regressoes, casos de borda nao tratados, logica que passa mas esta mal resolvida, riscos e testes ausentes.",
    "Nao decida se o codigo esta aprovado. Nao diga que os testes passaram ou falharam como veredito.",
    "Os checks automatizados ja foram executados pelo CLI; use o resumo apenas como contexto.",
    "A revisao e uma opiniao para um desenvolvedor humano avaliar.",
    "",
    "Resumo dos checks:",
    resumoChecks,
    "",
    "Saida dos checks que falharam:",
    saidasChecksFalhos || "(nenhum check falhou com saida capturada)",
    "",
    "Diff:",
    "```diff",
    diff,
    "```",
  ].join("\n");
}

function imprimirRelatorioVerify(relatorio: RelatorioVerify) {
  const limitarSaida = (saida: string) =>
    saida.length > 2000 ? saida.slice(-2000) : saida;

  console.log("");
  console.log("FRIDAY VERIFY");
  console.log(`Branch: ${relatorio.branch}`);
  console.log(`Arquivos alterados: ${relatorio.arquivosAlterados.length}`);

  if (relatorio.arquivosAlterados.length > 0) {
    relatorio.arquivosAlterados.forEach((arquivo) => console.log(`- ${arquivo}`));
  }

  console.log("");
  console.log("Checks:");

  if (relatorio.checks.length === 0) {
    console.log("- nenhum check configurado");
  } else {
    relatorio.checks.forEach((check) => {
      const status = check.passou ? "passou" : "falhou";
      const codigo = check.codigoSaida === null ? "sem codigo" : `codigo ${check.codigoSaida}`;
      console.log(`- ${status}: ${check.comando} (${codigo})`);

      if (!check.passou && check.saida.trim().length > 0) {
        console.log("  Saida:");
        console.log(limitarSaida(check.saida));
      }
    });
  }

  console.log("");
  console.log("Revisao da IA:");
  console.log(relatorio.revisao || "(sem revisao retornada)");
}

function salvarHistoricoVerify(raiz: string, relatorio: RelatorioVerify) {
  const pastaFriday = join(raiz, ".friday");
  const pastaHistorico = join(raiz, ".friday", "historico");
  const nomeArquivo = `${relatorio.timestamp.replace(/\.\d{3}Z$/, "").replace(/:/g, "-")}.json`;
  const caminhoRelatorio = join(pastaHistorico, nomeArquivo);
  const primeiraCriacao = !existsSync(pastaFriday);

  mkdirSync(pastaHistorico, { recursive: true });
  writeFileSync(caminhoRelatorio, `${JSON.stringify(relatorio, null, 2)}\n`, "utf-8");

  if (primeiraCriacao) {
    console.log("FRIDAY: criei a pasta .friday para o historico. Adicione .friday/ ao .gitignore se quiser evitar versionar esses relatorios.");
  }

  return caminhoRelatorio;
}

program
  .command("verify")
  .description("Roda checks locais e pede revisao do diff ao Codex")
  .action(() => {
    const raiz = process.cwd();
    const checks = lerChecksConfigurados(raiz);

    if (!dentroDeRepositorioGit(raiz)) {
      console.log("FRIDAY: este diretorio nao parece ser um repositorio git.");
      return;
    }

    const mudancas = capturarMudancasGit(raiz);

    if (!mudancas) {
      console.log("FRIDAY: nao consegui capturar o diff das mudancas nao commitadas.");
      return;
    }

    if (mudancas.arquivos.length === 0 || mudancas.diff.trim().length === 0) {
      console.log("FRIDAY: nao ha mudancas nao commitadas para verificar.");
      return;
    }

    const resultadosChecks: ResultadoCheck[] = [];

    if (checks.length === 0) {
      console.log("FRIDAY: nenhum check configurado em friday.yml.");
    } else {
      checks.forEach((check) => {
        console.log(`FRIDAY: rodando check: ${check}`);
        const resultado = rodarCheck(check, raiz);
        resultadosChecks.push(resultado);
        console.log(`FRIDAY: check ${resultado.passou ? "passou" : "falhou"}: ${check}`);
      });
    }

    console.log("FRIDAY: pedindo ao Codex uma revisao tecnica do diff...");
    const revisao = chamarCodex(montarPromptVerify(mudancas.diff, resultadosChecks));
    const relatorio: RelatorioVerify = {
      timestamp: new Date().toISOString(),
      branch: obterBranchAtual(raiz),
      arquivosAlterados: mudancas.arquivos,
      checks: resultadosChecks,
      revisao,
    };

    imprimirRelatorioVerify(relatorio);

    const caminhoRelatorio = salvarHistoricoVerify(raiz, relatorio);
    console.log("");
    console.log(`FRIDAY: historico salvo em ${caminhoRelatorio}`);
  });

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
