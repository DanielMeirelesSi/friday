import { Command } from "commander";

const program = new Command();

program
  .name("friday")
  .description("Assistente de desenvolvimento pela linha de comando")
  .version("1.0.0");

program
  .command("doc")
  .description("Gera documentacao tecnica do projeto")
  .action(() => {
    console.log("FRIDAY: comando doc chamado");
  });

program.parse();