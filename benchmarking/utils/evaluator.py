# type: ignore

class BaseInstanceEvaluator:
    def __init__(self, instance, config, run_logger = None):
        self.instance = instance
        self.config = config
        self.run_logger = run_logger

    async def evaluate(self):
        raise NotImplementedError("Subclasses must implement this method")