import { AstraDB } from "@datastax/astra-db-ts";
import { Collection } from "@datastax/astra-db-ts/dist/collections";
import { CreateCollectionOptions } from "@datastax/astra-db-ts/dist/collections/options";
import { BaseNode, Document, MetadataMode } from "../../Node";
import { VectorStore, VectorStoreQuery, VectorStoreQueryResult } from "./types";

const MAX_INSERT_BATCH_SIZE = 20;

export class AstraDBVectorStore implements VectorStore {
  storesText: boolean = true;
  flatMetadata: boolean = true;

  astraDBClient: AstraDB;
  idKey: string;
  contentKey: string | undefined; // if undefined the entirety of the node aside from the id and embedding will be stored as content
  metadataKey: string;

  private collection: Collection | undefined;

  constructor(
    init?: Partial<AstraDBVectorStore> & {
      params?: {
        token: string;
        endpoint: string;
      };
    }
  ) {
    if (init?.astraDBClient) {
      this.astraDBClient = init.astraDBClient;
    } else {
      const token =
        init?.params?.token ?? process.env.ASTRA_DB_APPLICATION_TOKEN;
      const endpoint = init?.params?.endpoint ?? process.env.ASTRA_DB_ENDPOINT;

      if (!token) {
        throw new Error(
          "Must specify ASTRA_DB_APPLICATION_TOKEN via env variable."
        );
      }
      if (!endpoint) {
        throw new Error("Must specify ASTRA_DB_ENDPOINT via env variable.");
      }
      this.astraDBClient = new AstraDB(token, endpoint);
    }

    this.idKey = init?.idKey ?? "_id";
    this.contentKey = init?.contentKey;
    this.metadataKey = init?.metadataKey ?? "metadata";
  }

  /**
   * Create a new collection in your Astra DB vector database.
   * You must still use connect() to connect to the collection.
   *
   * @param collection your new colletion's name
   * @param options: CreateCollectionOptions used to set the number of vector dimensions and similarity metric
   * @returns Promise that resolves if the creation did not throw an error.
   */
  async create(
    collection: string,
    options: CreateCollectionOptions
  ): Promise<void> {
    await this.astraDBClient.createCollection(collection, options);
    console.debug("Created Astra DB collection");

    return;
  }

  /**
   * Connect to an existing collection in your Astra DB vector database.
   * You must call this before adding, deleting, or querying.
   *
   * @param collection your existing colletion's name
   * @returns Promise that resolves if the connection did not throw an error.
   */
  async connect(collection: string): Promise<void> {
    this.collection = await this.astraDBClient.collection(collection);
    console.debug("Connected to Astra DB collection");

    return;
  }

  /**
   * Get an instance of your Astra DB client.
   * @returns the AstraDB client
   */
  client(): AstraDB {
    return this.astraDBClient;
  }

  /**
   * Add your document(s) to your Astra DB collection.
   *
   * @returns and array of node ids which were added
   */
  async add(nodes: BaseNode[]): Promise<string[]> {
    if (!this.collection) {
      throw new Error("Must connect to collection before adding.");
    }
    const collection = this.collection;

    if (!nodes || nodes.length === 0) {
      return [];
    }
    const dataToInsert = nodes.map((node) => {
      return {
        _id: node.id_,
        $vector: node.getEmbedding(),
        content: node.getContent(MetadataMode.ALL),
        metadata: node.metadata
      };
    });

    console.debug(`Adding ${dataToInsert.length} rows to table`);

    // Perform inserts in steps of MAX_INSERT_BATCH_SIZE
    let batchData: any[] = [];

    for (let i = 0; i < dataToInsert.length; i += MAX_INSERT_BATCH_SIZE) {
      batchData.push(dataToInsert.slice(i, i + MAX_INSERT_BATCH_SIZE));
    }

    for (const batch of batchData) {
      console.debug(`Inserting batch of size ${batch.length}`);

      const result = await collection.insertMany(batch);
    }

    return dataToInsert.map((node) => node._id);
  }

  /**
   * Delete a document from your Astra DB collection.
   *
   * @param refDocId the id of the document to delete
   * @param deleteOptions: any DeleteOneOptions to pass to the delete query
   * @returns Promise that resolves if the delete query did not throw an error.
   */
  async delete(refDocId: string, deleteOptions?: any): Promise<void> {
    if (!this.collection) {
      throw new Error("Must connect to collection before deleting.");
    }
    const collection = this.collection;

    console.debug(`Deleting row with id ${refDocId}`);

    await collection.deleteOne(
      {
        _id: refDocId
      },
      deleteOptions
    );
  }

  /**
   * Query documents from your Astra DB collection to get the closest match to your embedding.
   *
   * @param query: VectorStoreQuery
   * @param options: Not used
   */
  async query(
    query: VectorStoreQuery,
    options?: any
  ): Promise<VectorStoreQueryResult> {
    if (!this.collection) {
      throw new Error("Must connect to collection before querying.");
    }
    const collection = this.collection;

    const filters: Record<string, any> = {};
    query.filters?.filters?.forEach((f) => {
      filters[f.key] = f.value;
    });

    const cursor = await collection.find(filters, {
      sort: query.queryEmbedding
        ? { $vector: query.queryEmbedding }
        : undefined,
      limit: query.similarityTopK,
      includeSimilarity: true
    });

    const nodes: BaseNode[] = [];
    const ids: string[] = [];
    const similarities: number[] = [];

    await cursor.forEach(async (row: Record<string, any>) => {
      const id = row[this.idKey];
      const embedding = row.$vector;
      const similarity = row.$similarity;
      const metadata = row[this.metadataKey];

      // Remove fields from content
      delete row[this.idKey];
      delete row.$similarity;
      delete row.$vector;
      delete row[this.metadataKey];

      const content = this.contentKey
        ? row[this.contentKey]
        : JSON.stringify(row);

      const node = new Document({
        id_: id,
        text: content,
        metadata: metadata ?? {},
        embedding: embedding
      });

      ids.push(id);
      similarities.push(similarity);
      nodes.push(node);
    });

    return {
      similarities,
      ids,
      nodes
    };
  }
}
