import {
  Document,
  ResponseSynthesizer,
  TreeSummarize,
  TreeSummarizePrompt,
  VectorStoreIndex,
  serviceContextFromDefaults,
} from "llamaindex";

const treeSummarizePrompt: TreeSummarizePrompt = ({ context, query }) => {
  return `Context information from multiple sources is below.
---------------------
${context}
---------------------
Given the information from multiple sources and not prior knowledge.
Answer the query in the style of a Shakespeare play"
Query: ${query}
Answer:`;
};

async function main() {
  const documents = new Document({
    text: "The quick brown fox jumps over the lazy dog",
  });

  const index = await VectorStoreIndex.fromDocuments([documents]);

  const query = "The quick brown fox jumps over the lazy dog";

  const ctx = serviceContextFromDefaults({});

  const responseSynthesizer = new ResponseSynthesizer({
    responseBuilder: new TreeSummarize(ctx),
  });

  const queryEngine = index.asQueryEngine({
    responseSynthesizer,
  });

  const prompts = queryEngine.getPrompts();

  console.log({ prompts });

  queryEngine.updatePrompts({
    "responseSynthesizer:treeSummarize": treeSummarizePrompt,
  });

  const prompts2 = queryEngine.getPrompts();

  console.log({ prompts2 });
}

main();
