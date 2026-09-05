import { compute, type ComputationRequest, type ComputationResponse } from './computation';

self.onmessage = (event: MessageEvent<ComputationRequest>) => {
	const task = event.data;
	let response: ComputationResponse;
	try {
		response = { id: task.id, result: compute(task) };
	} catch (error) {
		response = { id: task.id, error: error instanceof Error ? error.message : String(error) };
	}
	self.postMessage(response);
};
