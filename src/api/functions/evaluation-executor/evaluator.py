# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
"""
Strands Evaluation Module for AgentCore Runtime

This module provides evaluation functionality using Strands Evaluation SDK.
It supports multiple built-in evaluators for assessing agent responses.

Classes:
    EvaluatorConfig: Configuration for creating evaluators
    EvaluationResult: Result of an evaluation run
    TrajectoryBuilder: Builds Session objects from trajectory data
    EvaluatorFactory: Factory for creating Strands evaluators
    EvaluationRunner: Orchestrates evaluation execution

Note: Requires strands-agents-evals package to be installed.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from strands_evals.evaluators import (
    FaithfulnessEvaluator,
    GoalSuccessRateEvaluator,
    HelpfulnessEvaluator,
    InteractionsEvaluator,
    OutputEvaluator,
    ToolParameterAccuracyEvaluator,
    ToolSelectionAccuracyEvaluator,
    TrajectoryEvaluator,
)
from strands_evals.types.evaluation import EvaluationData
from strands_evals.types.trace import AgentInvocationSpan, Session, SpanInfo, Trace

logger = logging.getLogger(__name__)


# ========================= Data Classes ========================= #


@dataclass
class EvaluatorConfig:
    """Configuration for creating an evaluator.

    Attributes:
        evaluator_type: Type of evaluator (e.g., "OutputEvaluator", "HelpfulnessEvaluator")
        rubric: Rubric for evaluators that support it
        model_id: Model ID for LLM-based evaluators
        pass_threshold: Score threshold for passing (0.0-1.0)
    """

    evaluator_type: str
    model_id: str
    pass_threshold: float
    rubric: str = ""


@dataclass
class EvaluationResult:
    """Result of an evaluation run.

    Attributes:
        score: Evaluation score (0.0-1.0)
        passed: Whether the evaluation passed based on threshold
        reason: Explanation of the evaluation result
        evaluator_type: Type of evaluator that produced this result
    """

    score: float
    passed: bool
    reason: str
    evaluator_type: str = ""

    def to_dict(self) -> dict:
        """Convert to dictionary representation."""
        return {
            "score": self.score,
            "passed": self.passed,
            "reason": self.reason,
            "evaluator_type": self.evaluator_type,
        }

    @classmethod
    def error(cls, message: str, evaluator_type: str = "") -> EvaluationResult:
        """Create an error result."""
        return cls(
            score=0.0,
            passed=False,
            reason=f"Evaluator error: {message}",
            evaluator_type=evaluator_type,
        )

    @classmethod
    def empty(cls, evaluator_type: str = "") -> EvaluationResult:
        """Create an empty result (no evaluation output)."""
        return cls(
            score=0.0,
            passed=False,
            reason="Evaluator returned empty result - no evaluation output",
            evaluator_type=evaluator_type,
        )


# ========================= TrajectoryBuilder ========================= #


class TrajectoryBuilder:
    """Builds Session objects from raw trajectory data.

    Evaluators like FaithfulnessEvaluator require AgentInvocationSpan with user_prompt
    to understand what the user asked. This class handles:
    1. Creating AgentInvocationSpan with user_prompt and agent_response
    2. Parsing existing tool execution spans from the trajectory
    3. Combining them into a complete Session
    """

    @staticmethod
    def build_session(
        trajectory: dict,
        user_prompt: str,
        agent_response: str,
    ) -> Session:
        """Build a Session with AgentInvocationSpan from trajectory data.

        Args:
            trajectory: Raw trajectory dict from AgentCore
            user_prompt: The user's input question
            agent_response: The agent's response

        Returns:
            Session with AgentInvocationSpan included
        """
        session_id = trajectory.get("session_id", str(uuid.uuid4()))
        now = datetime.now(timezone.utc)
        raw_traces = trajectory.get("traces", [])

        all_spans = []
        trace_id = str(uuid.uuid4())

        logger.info(
            f"Building session from trajectory with {len(raw_traces)} traces, "
            f"session_id={session_id}"
        )

        # Parse tool execution spans and create AgentInvocationSpan
        for raw_trace in raw_traces:
            try:
                if isinstance(raw_trace, dict):
                    trace_id = raw_trace.get("trace_id", trace_id)

                    # Create AgentInvocationSpan with this trace's trace_id
                    agent_span = TrajectoryBuilder._create_agent_span(
                        session_id=session_id,
                        trace_id=trace_id,
                        user_prompt=user_prompt,
                        agent_response=agent_response,
                        timestamp=now,
                    )
                    all_spans.append(agent_span)

                    # Parse and add tool execution spans
                    parsed_trace = Trace.model_validate(raw_trace)
                    all_spans.extend(parsed_trace.spans)
                    logger.info(
                        f"Parsed trace {trace_id} with {len(parsed_trace.spans)} tool spans"
                    )
                elif isinstance(raw_trace, Trace):
                    all_spans.extend(raw_trace.spans)
            except Exception as e:
                logger.warning(f"Failed to parse trace: {e}")

        # Create AgentInvocationSpan if no traces present (evaluators need it)
        if not all_spans:
            logger.info(
                "No traces in trajectory, creating AgentInvocationSpan without tool calls"
            )
            agent_span = TrajectoryBuilder._create_agent_span(
                session_id=session_id,
                trace_id=trace_id,
                user_prompt=user_prompt,
                agent_response=agent_response,
                timestamp=now,
            )
            all_spans.append(agent_span)

        # Create single trace with ALL spans
        combined_trace = Trace(
            spans=all_spans,
            trace_id=trace_id,
            session_id=session_id,
        )

        logger.info(f"Built session with {len(all_spans)} total spans")
        return Session(traces=[combined_trace], session_id=session_id)

    @staticmethod
    def _create_agent_span(
        session_id: str,
        trace_id: str,
        user_prompt: str,
        agent_response: str,
        timestamp: datetime,
    ) -> AgentInvocationSpan:
        """Create an AgentInvocationSpan."""
        return AgentInvocationSpan(
            span_info=SpanInfo(
                session_id=session_id,
                trace_id=trace_id,
                span_id=str(uuid.uuid4()),
                start_time=timestamp,
                end_time=timestamp,
            ),
            user_prompt=user_prompt,
            agent_response=agent_response,
            available_tools=[],
        )

    @staticmethod
    def build_swarm_session(
        trajectory: Optional[dict],
        user_prompt: str,
        agent_response: str,
    ) -> Session:
        """Build a Session from swarm trajectory data.

        Creates a Session object with AgentInvocationSpans representing each
        agent node in the swarm execution. This allows evaluators that require
        Session objects to work with swarm data.

        If trajectory is None or empty, creates a minimal Session with just
        the user prompt and agent response (fallback for error cases).

        Args:
            trajectory: Swarm trajectory dict with 'trajectory' list and 'interactions'
                       Can be None if trajectory capture failed
            user_prompt: The user's input question
            agent_response: The final agent's response

        Returns:
            Session with spans for each swarm agent node (or minimal Session if no data)
        """
        now = datetime.now(timezone.utc)
        trace_id = str(uuid.uuid4())

        session_id = str(uuid.uuid4())

        # Handle None or empty trajectory
        if not trajectory:
            logger.warning(
                "Swarm trajectory is None or empty, creating Session with main span only"
            )
            node_list = []
            interactions = []
        else:
            session_id = trajectory.get("session_id", session_id)
            # Get the list of agent nodes from swarm trajectory
            node_list = trajectory.get("trajectory", []) or []
            interactions = trajectory.get("interactions", []) or []

        logger.info(
            f"Building swarm session with {len(node_list)} nodes, "
            f"{len(interactions)} interactions, session_id={session_id}"
        )

        all_spans = []

        # Create an AgentInvocationSpan for the overall conversation
        main_span = TrajectoryBuilder._create_agent_span(
            session_id=session_id,
            trace_id=trace_id,
            user_prompt=user_prompt,
            agent_response=agent_response,
            timestamp=now,
        )
        all_spans.append(main_span)

        # Create spans for each agent node in the swarm trajectory
        for i, node_name in enumerate(node_list):
            # Find corresponding interaction if available
            node_message = ""
            for interaction in interactions:
                if (
                    isinstance(interaction, dict)
                    and interaction.get("node_name") == node_name
                ):
                    raw_messages = interaction.get("messages", "")
                    # Handle messages that could be a list or string
                    if isinstance(raw_messages, list):
                        node_message = "\n".join(str(m) for m in raw_messages)
                    else:
                        node_message = str(raw_messages) if raw_messages else ""
                    break

            # Create a span representing this agent node's execution
            # Note: agent_response must be a string, not a list
            node_span = AgentInvocationSpan(
                span_info=SpanInfo(
                    session_id=session_id,
                    trace_id=trace_id,
                    span_id=str(uuid.uuid4()),
                    start_time=now,
                    end_time=now,
                ),
                user_prompt=f"[Swarm node {i+1}: {node_name}]",
                agent_response=node_message or f"Executed by {node_name}",
                available_tools=[],
            )
            all_spans.append(node_span)

        # Create AgentInvocationSpan if no traces present (evaluators need it)
        if not all_spans:
            logger.info(
                "No traces in trajectory, creating AgentInvocationSpan without tool calls"
            )
            agent_span = TrajectoryBuilder._create_agent_span(
                session_id=session_id,
                trace_id=trace_id,
                user_prompt=user_prompt,
                agent_response=agent_response,
                timestamp=now,
            )
            all_spans.append(agent_span)

        # Create single trace with all spans
        combined_trace = Trace(
            spans=all_spans,
            trace_id=trace_id,
            session_id=session_id,
        )

        logger.info(f"Built swarm session with {len(all_spans)} total spans")
        return Session(traces=[combined_trace], session_id=session_id)


# ========================= EvaluatorFactory ========================= #


class EvaluatorFactory:
    """Factory for creating Strands evaluators.

    Supports the following evaluator types:
    - OutputEvaluator: Compares actual vs expected output (requires rubric)
    - HelpfulnessEvaluator: Evaluates response helpfulness
    - FaithfulnessEvaluator: Checks factual accuracy
    - GoalSuccessRateEvaluator: Evaluates if all user goals were achieved (binary: 1.0=success, 0.0=failure)
    - ToolSelectionAccuracyEvaluator: Validates tool selection
    - ToolParameterAccuracyEvaluator: Validates tool parameters
    - TrajectoryEvaluator: Assesses sequence of actions/tool calls taken by an agent (requires rubric)
    - InteractionsEvaluator: Evaluates how well the agent interacts with users (requires rubric)
    """

    # Mapping of evaluator type names to classes
    EVALUATOR_CLASSES = {
        "OutputEvaluator": OutputEvaluator,
        "HelpfulnessEvaluator": HelpfulnessEvaluator,
        "FaithfulnessEvaluator": FaithfulnessEvaluator,
        "GoalSuccessRateEvaluator": GoalSuccessRateEvaluator,
        "ToolSelectionAccuracyEvaluator": ToolSelectionAccuracyEvaluator,
        "ToolParameterAccuracyEvaluator": ToolParameterAccuracyEvaluator,
        "TrajectoryEvaluator": TrajectoryEvaluator,
        "InteractionsEvaluator": InteractionsEvaluator,
    }

    # Evaluators that require a rubric parameter
    EVALUATORS_REQUIRING_RUBRIC = {
        "OutputEvaluator",
        "TrajectoryEvaluator",
        "InteractionsEvaluator",
    }

    @classmethod
    def get_available_types(cls) -> List[str]:
        """Get list of available evaluator types."""
        return list(cls.EVALUATOR_CLASSES.keys())

    @classmethod
    def create(cls, config: EvaluatorConfig) -> Any:
        """Create an evaluator from configuration.

        Args:
            config: Evaluator configuration

        Returns:
            Strands evaluator instance

        Raises:
            ValueError: If evaluator_type is not recognized
        """
        if config.evaluator_type not in cls.EVALUATOR_CLASSES:
            raise ValueError(
                f"Unknown evaluator type: {config.evaluator_type}. "
                f"Valid types: {cls.get_available_types()}"
            )

        evaluator_class = cls.EVALUATOR_CLASSES[config.evaluator_type]

        # Only certain evaluators require rubric parameter
        if config.evaluator_type in cls.EVALUATORS_REQUIRING_RUBRIC:
            rubric = config.rubric.strip() if config.rubric else ""
            return evaluator_class(
                rubric=rubric,
                model=config.model_id,
                include_inputs=True,
            )
        else:
            return evaluator_class(model=config.model_id)

    @classmethod
    def create_from_type(
        cls,
        evaluator_type: str,
        model_id: str,
        pass_threshold: float,
        rubric: str = "",
    ) -> Any:
        """Convenience method to create evaluator from type string.

        Args:
            evaluator_type: Type of evaluator
            model_id: Model ID for LLM-based evaluators
            rubric: Rubric of evaluator

        Returns:
            Strands evaluator instance
        """
        config = EvaluatorConfig(
            evaluator_type=evaluator_type,
            model_id=model_id,
            rubric=rubric,
            pass_threshold=pass_threshold,
        )
        return cls.create(config)


# ========================= EvaluationRunner ========================= #


class EvaluationRunner:
    """Orchestrates evaluation execution.

    Handles:
    - Building trajectory sessions
    - Running evaluations
    - Processing results
    """

    def __init__(
        self,
        model_id: str,
        pass_threshold: float,
    ):
        """Initialize the evaluation runner.

        Args:
            model_id: Default model for LLM-based evaluators
            pass_threshold: Score threshold for passing (0.0-1.0)
        """
        self.model_id = model_id
        self.pass_threshold = pass_threshold
        self._trajectory_builder = TrajectoryBuilder()

    def evaluate(
        self,
        evaluator_type: str,
        input_text: str,
        expected_output: str,
        actual_output: str,
        rubric: str = "",
        trajectory: Optional[dict] = None,
        case_name: str = "eval-case",
        expected_trajectory: Optional[List[str]] = None,
        expected_interactions: Optional[List[dict]] = None,
    ) -> EvaluationResult:
        """Run evaluation using specified evaluator type.

        Args:
            evaluator_type: Type of evaluator to use
            input_text: The input that was sent to the agent
            expected_output: The expected output
            actual_output: The actual output from the agent
            rubric: Optional rubric for evaluators that support it
            trajectory: Optional trajectory data from agent execution (supports both
                        single agent format with 'traces' and swarm format with
                        'trajectory' and 'interactions')
            case_name: Name for the test case
            expected_trajectory: Optional expected sequence of agent/tool names
            expected_interactions: Optional expected interactions for swarm agents
                Each interaction: {"node_name": str, "dependencies": [str], "messages": str}

        Returns:
            EvaluationResult with score, passed status, and reason
        """
        logger.info(
            f"Running {evaluator_type} evaluation, "
            f"input_length={len(input_text)}, "
            f"has_trajectory={trajectory is not None}"
        )

        try:
            # Create evaluator
            evaluator = EvaluatorFactory.create_from_type(
                evaluator_type=evaluator_type,
                rubric=rubric,
                model_id=self.model_id,
                pass_threshold=self.pass_threshold,
            )

            # Build trajectory session if provided
            actual_trajectory_session = None  # Session object for most evaluators
            actual_interactions = None  # List for InteractionsEvaluator

            if trajectory:
                try:
                    # Detect trajectory format and process accordingly
                    # Swarm format has 'interactions' key with agent-to-agent handoff data
                    is_swarm_format = "interactions" in trajectory

                    if is_swarm_format:
                        # Swarm format: extract interactions and agent sequence
                        actual_interactions = trajectory.get("interactions")
                        actual_trajectory_list = trajectory.get("trajectory", [])

                        logger.info(
                            f"Swarm trajectory: {len(actual_trajectory_list)} nodes, "
                            f"{len(actual_interactions) if actual_interactions else 0} interactions"
                        )

                        # Build Session object from swarm data for evaluators that need it
                        actual_trajectory_session = (
                            TrajectoryBuilder.build_swarm_session(
                                trajectory=trajectory,
                                user_prompt=input_text,
                                agent_response=actual_output,
                            )
                        )

                    else:
                        # Single agent format: build Session from OpenTelemetry traces
                        actual_trajectory_session = TrajectoryBuilder.build_session(
                            trajectory=trajectory,
                            user_prompt=input_text,
                            agent_response=actual_output,
                        )
                        logger.info(
                            f"Single agent trajectory: {len(trajectory.get('traces', []))} traces"
                        )

                except Exception as e:
                    logger.warning(f"Failed to build session from trajectory: {e}")

            # Create evaluation data with appropriate trajectory/interactions
            eval_data_kwargs: Dict[str, Any] = {
                "input": input_text,
                "expected_output": expected_output,
                "actual_output": actual_output,
                "name": case_name,
            }

            # Add trajectory session for evaluators that need it
            if actual_trajectory_session:
                eval_data_kwargs["actual_trajectory"] = actual_trajectory_session

            # Add interactions for InteractionsEvaluator
            if actual_interactions:
                eval_data_kwargs["actual_interactions"] = actual_interactions

            # Add expected trajectory if provided
            if expected_trajectory:
                eval_data_kwargs["expected_trajectory"] = expected_trajectory
                logger.info(f"Expected trajectory: {expected_trajectory}")

            # Add expected interactions if provided (for InteractionsEvaluator)
            if expected_interactions:
                eval_data_kwargs["expected_interactions"] = expected_interactions
                logger.info(
                    f"Expected interactions: {len(expected_interactions)} nodes"
                )

            eval_data = EvaluationData(**eval_data_kwargs)

            # Run evaluation
            result = evaluator.evaluate(eval_data)

            if not result:
                logger.warning("Evaluator returned empty result")
                return EvaluationResult.empty(evaluator_type)

            # Process result
            eval_output = result[0]
            score = getattr(eval_output, "score", 0.0)
            passed = score >= self.pass_threshold
            reason = getattr(eval_output, "reason", "")

            logger.info(f"Evaluation complete: score={score}, passed={passed}")

            return EvaluationResult(
                score=score,
                passed=passed,
                reason=reason,
                evaluator_type=evaluator_type,
            )

        except Exception as e:
            logger.exception(f"Failed to run evaluation: {e}")
            return EvaluationResult.error(str(e), evaluator_type)

    def evaluate_batch(
        self,
        evaluator_configs: List[Dict[str, str]],
        input_text: str,
        expected_output: str,
        actual_output: str,
        trajectory: Optional[dict] = None,
    ) -> List[EvaluationResult]:
        """Run multiple evaluations in batch.

        Args:
            evaluator_configs: List of evaluator configurations
            input_text: The input that was sent to the agent
            expected_output: The expected output
            actual_output: The actual output from the agent
            trajectory: Optional trajectory data

        Returns:
            List of EvaluationResults
        """
        results = []
        for config in evaluator_configs:
            result = self.evaluate(
                evaluator_type=config.get("type", ""),
                input_text=input_text,
                expected_output=expected_output,
                actual_output=actual_output,
                rubric=config.get("rubric", ""),
                trajectory=trajectory,
            )
            results.append(result)
        return results
