import jsonlines
import argparse
import json
import os
from tqdm import tqdm

base_dir = "/workspace/haoran-cloud/code/kimi-cli/results"

def get_predictions(run_id):
    with open("/workspace/swe-data/dataset/rl/swebench-verified.jsonl", "r") as f:
        dataset = list(jsonlines.Reader(f))
        ids = [row["instance_id"] for row in dataset]

    result_file = f'{base_dir}/{run_id}/results.jsonl'
    with jsonlines.open(result_file, "r") as f:
        results = list(f)
    preds = [{
        "instance_id": result["instance_id"],
        "model_patch": result["git_patch"],
        "model_name_or_path": run_id
    } for result in results]
    with jsonlines.open(f'{base_dir}/{run_id}/predictions.jsonl', "w") as f:
        f.write_all(preds)
        
if __name__ == "__main__":
    # get run id from arg
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", type=str, required=True)
    args = parser.parse_args()
    run_id = args.run_id
    get_predictions(run_id)