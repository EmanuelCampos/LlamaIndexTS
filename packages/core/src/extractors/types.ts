import { BaseNode, MetadataMode, TextNode } from "../Node";

const DEFAULT_NODE_TEXT_TEMPLATE =
  "\
[Excerpt from document]\n{metadata_str}\n\
Excerpt:\n-----\n{content}\n-----\n";

/*
 * Abstract class for all extractors.
 */
export abstract class BaseExtractor {
  isTextNodeOnly: boolean = true;
  showProgress: boolean = true;
  metadataMode: MetadataMode = MetadataMode.ALL;
  nodeTextTemplate: string = DEFAULT_NODE_TEXT_TEMPLATE;
  disableTemplateRewrite: boolean = false;
  inPlace: boolean = true;
  numWorkers: number = 4;

  abstract extract(nodes: BaseNode[]): Promise<Record<string, any>[]>;

  /**
   *
   * @param nodes Nodes to extract metadata from.
   * @param excludedEmbedMetadataKeys Metadata keys to exclude from the embedding.
   * @param excludedLlmMetadataKeys Metadata keys to exclude from the LLM.
   * @returns Metadata extracted from the nodes.
   */
  async processNodes(
    nodes: BaseNode[],
    excludedEmbedMetadataKeys: string[] | undefined = undefined,
    excludedLlmMetadataKeys: string[] | undefined = undefined,
  ): Promise<BaseNode[]> {
    let newNodes: BaseNode[];

    if (this.inPlace) {
      newNodes = nodes;
    } else {
      newNodes = nodes.slice();
    }

    let curMetadataList = await this.extract(newNodes);

    for (let idx in newNodes) {
      newNodes[idx].metadata = curMetadataList[idx];
    }

    for (let idx in newNodes) {
      if (excludedEmbedMetadataKeys) {
        newNodes[idx].excludedEmbedMetadataKeys.concat(
          excludedEmbedMetadataKeys,
        );
      }
      if (excludedLlmMetadataKeys) {
        newNodes[idx].excludedLlmMetadataKeys.concat(excludedLlmMetadataKeys);
      }
      if (!this.disableTemplateRewrite) {
        if (newNodes[idx] instanceof TextNode) {
          newNodes[idx] = new TextNode({
            ...newNodes[idx],
            textTemplate: this.nodeTextTemplate,
          });
        }
      }
    }

    return newNodes;
  }
}
