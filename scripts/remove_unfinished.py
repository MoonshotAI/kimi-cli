import jsonlines
count = 0
with jsonlines.open("/workspace/haoran-cloud/code/kimi-cli/results/GLM-4.7_20260113_073336/results.jsonl", "r") as f:
    results = list(f)
filtered_results = []
for result in results:
    messages = result["messages"]
    if not messages:
        continue
    # last_msg = messages[-2]
    # try:
    #     finish = last_msg["tool_calls"][0]["function"]["name"] == "Finish"
    # except:
    #     finish = False
    # messages = [msg for msg in messages if msg["role"] in ["user", "system", "assistant", "tool"]]
    last_msg = messages[-1]
    try:
        finish = "Task finished" in last_msg["content"]
        if not finish:
            print(last_msg)
    except:
        print(last_msg)
        finish = False
    if finish:
        count += 1
        filtered_results.append(result)
print(count)
with jsonlines.open("/workspace/haoran-cloud/code/kimi-cli/results/GLM-4.7_20260113_073336/results_filtered.jsonl", "w") as f:
    f.write_all(filtered_results)