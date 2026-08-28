import { Command } from "commander";
import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";

const program = new Command();

program
  .name("friday")
  .description("Assistente de desenvolvimento pela linha de comando")
  .version("1.0.0");

function extrairEstrutura(conteudo: string) {
  const linhas = conteudo.split("\n");
  const encontrados: { linha: number; tipo: string; nome: string }[] = [];

  linhas.forEach((texto, indice) => {
    const funcao = texto.match(/function\s+([a-zA-Z0-9_]+)/);
    if (funcao) {
      encontrados.push({ linha: indice + 1, tipo: "funcao", nome: funcao[1] });
    }

    const classe = texto.match(/class\s+([a-zA-Z0-9_]+)/);
    if (classe) {
      encontrados.push({ linha: indice + 1, tipo: "classe", nome: classe[1] });
    }
  });

  return encontrados;
}

program
  .command("doc")
  .description("Gera documentacao tecnica do projeto")
  .argument("<arquivo>", "caminho do arquivo a documentar")
  .action((arquivo: string) => {
    if (!existsSync(arquivo)) {
      console.log(`FRIDAY: nao encontrei o arquivo "${arquivo}". Confira o caminho.`);
      return;
    }

    const conteudo = readFileSync(arquivo, "utf-8");
    const totalLinhas = conteudo.split("\n").length;
    const estrutura = extrairEstrutura(conteudo);

    console.log(`Arquivo: ${basename(arquivo)}`);
    console.log(`Linhas: ${totalLinhas}`);
    console.log(`Elementos encontrados: ${estrutura.length}`);
    console.log("");

    estrutura.forEach((item) => {
      console.log(`  linha ${item.linha}: ${item.tipo} ${item.nome}`);
    });
  });

program.parse();