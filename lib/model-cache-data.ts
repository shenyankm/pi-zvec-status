// zvec-grep 0.2.2 artifact snapshots (Hugging Face and ModelScope).
export interface ModelSnapshot {
  directory: string;
  fingerprint: string;
  files: [localPath: string, size: number, artifactPath?: string][];
}

export const modelSnapshots: Record<string, ModelSnapshot[]> = {
  "local/qwen3-embedding-0.6b": [
    {"directory":"","fingerprint":"cc8a5875f013bf011e1932e9","files":[["hf_Qwen_Qwen3-Embedding-0.6B-Q8_0.gguf",639150592,"Qwen3-Embedding-0.6B-Q8_0.gguf"]]},
    {"directory":"modelscope/llama-cpp/Qwen--Qwen3-Embedding-0.6B-GGUF/61ae123505fc6fa7f36d372fae1a30bc384241ea","fingerprint":"93b0ff2267bba27a5adb94d4","files":[["Qwen3-Embedding-0.6B-Q8_0.gguf",639150592]]},
  ],
  "local/potion-code-16m-v2": [
    {"directory":"model2vec/minishlab--potion-code-16M-v2/e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b","fingerprint":"7db565dd4d3a5969b4c61568","files":[["model.safetensors",32490072],["tokenizer/tokenizer.json",1024340,"tokenizer.json"]]},
    {"directory":"modelscope/model2vec/minishlab--potion-code-16M-v2/3e922fde18f43b8db69f3381b6d468738d3dd2d7","fingerprint":"dd1101fea40b5b4afdeadea4","files":[["model.safetensors",32490072],["tokenizer/tokenizer.json",1024340,"tokenizer.json"]]},
  ],
  "local/potion-retrieval-32m": [
    {"directory":"model2vec/minishlab--potion-retrieval-32M/6fc8051fab2a1e0ee76689cf08c853792ac285e7","fingerprint":"ce8f85ee04990db7b11fadc9","files":[["model.safetensors",129210456],["tokenizer/tokenizer.json",1493150,"tokenizer.json"]]},
    {"directory":"modelscope/model2vec/minishlab--potion-retrieval-32M/33da23fc75cb732b5370bf25adde3db74b0d65b3","fingerprint":"fc9b7505795f33eb675295cd","files":[["model.safetensors",129210456],["tokenizer/tokenizer.json",1493150,"tokenizer.json"]]},
  ],
  "local/potion-multilingual-128m": [
    {"directory":"model2vec/minishlab--potion-multilingual-128M/73908c3438cf03b6a01bcb9611d62b23d0726f08","fingerprint":"adbe103a0d1c82cbcc163ac4","files":[["model.safetensors",512361560],["tokenizer/tokenizer.json",18616131,"tokenizer.json"]]},
    {"directory":"modelscope/model2vec/minishlab--potion-multilingual-128M/e8524678123f281add99f9745ac33d6604434dd7","fingerprint":"95920e151482e3444a6993fc","files":[["model.safetensors",512361560],["tokenizer/tokenizer.json",18616131,"tokenizer.json"]]},
  ],
  "local/multilingual-e5-small": [
    {"directory":"Xenova/multilingual-e5-small/761b726dd34fb83930e26aab4e9ac3899aa1fa78","fingerprint":"a6d8f01ab2e18750a6882ab4","files":[["config.json",658],["tokenizer.json",17082730],["tokenizer_config.json",443],["onnx/model_quantized.onnx",118308185]]},
    {"directory":"modelscope/transformers-js/Xenova--multilingual-e5-small/252d0dcb679dda2c7b6fd5bbfed15df3c7feaebf","fingerprint":"7ee2159fc46445e29201c078","files":[["config.json",658],["tokenizer.json",17082730],["tokenizer_config.json",443],["onnx/model_quantized.onnx",118308185]]},
  ],
  "local/all-minilm-l6-v2": [
    {"directory":"onnx-community/all-MiniLM-L6-v2-ONNX/aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f","fingerprint":"549ab78291becc04a7ee7ee0","files":[["config.json",794],["tokenizer.json",533808],["tokenizer_config.json",1463],["onnx/model_q4.onnx",69663],["onnx/model_q4.onnx_data",54429696]]},
    {"directory":"modelscope/transformers-js/onnx-community--all-MiniLM-L6-v2-ONNX/e1da369847063d70f2fd772226551865bcab1c2d","fingerprint":"2e6e1ab7dd877094356f7765","files":[["config.json",794],["tokenizer.json",533808],["tokenizer_config.json",1463],["onnx/model_q4.onnx",69663],["onnx/model_q4.onnx_data",54429696]]},
  ],
  "local/bge-small-en-v1.5": [
    {"directory":"onnx-community/bge-small-en-v1.5-ONNX/4a9a46c7b88fa408e650a571a1800243f26309bd","fingerprint":"159317bdd9796e8906d6c5d5","files":[["config.json",867],["tokenizer.json",533603],["tokenizer_config.json",1271],["onnx/model_q4.onnx",132562],["onnx/model_q4.onnx_data",61185024]]},
    {"directory":"modelscope/transformers-js/onnx-community--bge-small-en-v1.5-ONNX/f246b360b061b613fe0b449f2e14de12f875dad7","fingerprint":"4eb2901fe00ad41d5a5a8c33","files":[["config.json",867],["tokenizer.json",533603],["tokenizer_config.json",1271],["onnx/model_q4.onnx",132562],["onnx/model_q4.onnx_data",61185024]]},
  ],
  "local/embeddinggemma-300m": [
    {"directory":"","fingerprint":"efec4039b54e689ff153b650","files":[["hf_ggml-org_embeddinggemma-300M-Q8_0.gguf",333590944,"embeddinggemma-300M-Q8_0.gguf"]]},
    {"directory":"modelscope/llama-cpp/ggml-org--embeddinggemma-300M-GGUF/e2fab2963ac0943b1dc320cf0e267bd0e06e2e97","fingerprint":"b70108271b41741ba07d8eef","files":[["embeddinggemma-300M-Q8_0.gguf",333590944]]},
  ],
  "local/gte-modernbert-base": [
    {"directory":"Alibaba-NLP/gte-modernbert-base/e7f32e3c00f91d699e8c43b53106206bcc72bb22","fingerprint":"728d56151fb4cc9ba0d99f09","files":[["config.json",1184],["tokenizer.json",3583228],["tokenizer_config.json",20867],["onnx/model_q4.onnx",224152761]]},
    {"directory":"modelscope/transformers-js/iic--gte-modernbert-base/678f4ed93760af288132f4f9dc5b6daebdc48777","fingerprint":"02c014ebf033d160f6c2c9dd","files":[["config.json",1184],["tokenizer.json",3583228],["tokenizer_config.json",20867],["onnx/model_q4.onnx",224152761]]},
  ],
  "local/jina-embeddings-v2-base-code": [
    {"directory":"jinaai/jina-embeddings-v2-base-code/516f4baf13dec4ddddda8631e019b5737c8bc250","fingerprint":"0da63afbfa58884956991b48","files":[["config.json",1216],["tokenizer.json",2561316],["tokenizer_config.json",493],["onnx/model_quantized.onnx",161895621]]},
    {"directory":"modelscope/transformers-js/jinaai--jina-embeddings-v2-base-code/91aa0a6aa801c408149324e32e8cd43f8502da8f","fingerprint":"6e7f089d82aa49b0abe5ab91","files":[["config.json",1216],["tokenizer.json",2561316],["tokenizer_config.json",493],["onnx/model_quantized.onnx",161895621]]},
  ],
  "local/nomic-embed-text-v1.5": [
    {"directory":"nomic-ai/nomic-embed-text-v1.5/e9b6763023c676ca8431644204f50c2b100d9aab","fingerprint":"7047a157022c8224f7d7ecf3","files":[["config.json",2538],["tokenizer.json",711396],["tokenizer_config.json",1191],["onnx/model_q4.onnx",165113221]]},
    {"directory":"modelscope/transformers-js/nomic-ai--nomic-embed-text-v1.5/c6fb77fdf73531ee8319b34e46f7e749b59e74e8","fingerprint":"c5de32811aa08c102eac68b3","files":[["config.json",2538],["tokenizer.json",711396],["tokenizer_config.json",1191],["onnx/model_q4.onnx",165113221]]},
  ],
};
