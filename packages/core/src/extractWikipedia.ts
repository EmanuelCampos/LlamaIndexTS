import fs from "fs";
import path from "path";

const dataPath = path.join(__dirname, "data");

const extractWikipediaTitle = async (title: string) => {
  const fileExists = fs.existsSync(path.join(dataPath, `${title}.txt`));

  if (fileExists) {
    console.log(`Arquivo já existe para o título: ${title}`);
    return;
  }

  const queryParams = new URLSearchParams({
    action: "query",
    format: "json",
    titles: title,
    prop: "extracts",
    explaintext: "true",
  });

  const url = `https://en.wikipedia.org/w/api.php?${queryParams}`;

  const response = await fetch(url);
  const data: any = await response.json();

  const pages = data.query.pages;
  const page = pages[Object.keys(pages)[0]];
  const wikiText = page.extract;

  fs.writeFile(path.join(dataPath, `${title}.txt`), wikiText, (err: any) => {
    if (err) {
      console.error(err);
      return;
    }
    console.log(`Arquivo salvo para o título: ${title}`);
  });
};

export const extractWikipedia = async (titles: string[]) => {
  if (!fs.existsSync(dataPath)) {
    fs.mkdirSync(dataPath);
  }

  for (const title of titles) {
    await extractWikipediaTitle(title);
  }

  console.log("Extration finished!");
};
