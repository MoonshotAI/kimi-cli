from benchmarking.utils.evaluator import InstanceEvaluator
from benchmarking.utils.config import EvalResult

class SWEBenchInstanceEvaluator(InstanceEvaluator):
    def __init__(self, instance, config, run_logger = None):
        super().__init__(instance, config, run_logger)

    async def evaluate(self) -> EvalResult:
        return await super().evaluate()